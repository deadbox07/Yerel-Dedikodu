const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 6 * 1024 * 1024, // 6 MB (foto + ses için)
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_GLOBAL = 400;
const MAX_THREAD = 300;
const MAX_USERS = 600;

const MAX_IMAGE_B64 = 1_200_000;  // ~900 KB
const MAX_AUDIO_B64 = 3_200_000;  // ~2.4 MB
const ALLOWED_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav',
];
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));

let db = { users: {}, global: [], dms: {}, reads: {} };
let pool = null;
let storageMode = 'file';
let saveTimer = null;
let dirty = false;
let dbError = null;
let dbRetryTimer = null;

/* ------------------------------------------------------------------ */
/*  DEPOLAMA                                                          */
/* ------------------------------------------------------------------ */

function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const dms = p.dms && typeof p.dms === 'object' ? p.dms : {};
  // silinmiş mesajlar artık hiç tutulmuyor: eski kayıtlardan da temizle
  if (dms) {
    for (const t of Object.values(dms)) {
      if (t && Array.isArray(t.messages)) t.messages = t.messages.filter((m) => m && !m.deleted);
    }
  }
  return {
    users: p.users && typeof p.users === 'object' ? p.users : {},
    global: Array.isArray(p.global) ? p.global.filter((m) => m && !m.deleted).slice(-MAX_GLOBAL) : [],
    dms,
    reads: p.reads && typeof p.reads === 'object' ? p.reads : {},
  };
}

function loadFile() {
  try {
    db = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    healAdmins();
    console.log('💾 Veri data.json dosyasından yüklendi');
  } catch (e) {}
}

async function initStorage() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    loadFile();
    storageMode = 'file';
    console.log('⚠️  DATABASE_URL yok → veriler sadece sunucu açıkken korunur');
    return;
  }
  try {
    const { Pool } = require('pg');
    const useSSL = String(process.env.PGSSL || '').toLowerCase() !== 'disable';
    pool = new Pool({
      connectionString: url,
      ssl: useSSL ? { rejectUnauthorized: false } : false,
      max: 3,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 15000,
    });
    pool.on('error', (e) => console.error('PostgreSQL havuz hatası:', e.message));

    await pool.query(`
      CREATE TABLE IF NOT EXISTS yd_state (
        key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS yd_media (
        id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, ts BIGINT NOT NULL
      )`);
    const r = await pool.query("SELECT value FROM yd_state WHERE key = 'db'");
    if (r.rows[0]) db = normalize(r.rows[0].value);
  healAdmins();
    storageMode = 'postgres';
    dbError = null;
    console.log('✅ PostgreSQL bağlı — sohbet + medya KALICI');
    if (dbRetryTimer) { clearInterval(dbRetryTimer); dbRetryTimer = null; }
  } catch (e) {
    dbError = e.message || String(e);
    console.error('❌ Veritabanına bağlanılamadı:', dbError);
    if (pool) { try { await pool.end(); } catch (_) {} }
    pool = null;
    storageMode = 'file';
    loadFile();
    if (!dbRetryTimer) {
      dbRetryTimer = setInterval(() => {
        if (storageMode !== 'postgres' && process.env.DATABASE_URL) initStorage();
      }, 60000);
    }
  }
}

async function persistNow() {
  dirty = false;
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO yd_state (key, value, updated_at) VALUES ('db', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(db)]
      );
      return;
    } catch (e) {
      console.error('Kayıt hatası (veritabanı):', e.message);
    }
  }
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) {}
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 600);
}
setInterval(() => { if (dirty && !saveTimer) persistNow(); }, 10000);

async function shutdown(sig) {
  console.log(`\n${sig} alındı, veriler kaydediliyor…`);
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await persistNow();
  if (pool) { try { await pool.end(); } catch (_) {} }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ------------------------------------------------------------------ */
/*  MEDYA (foto / ses)                                                */
/* ------------------------------------------------------------------ */

async function storeMedia(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  // data:audio/webm;codecs=opus;base64,....  → codecs parametresini de kabul et
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)((?:;[a-z0-9=._+-]+)*);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!m) return null;
  const mime = m[1].toLowerCase();          // codecs kısmını at, sadece ana tip
  const b64 = m[3].replace(/\s+/g, '');
  if (!ALLOWED_MIME.includes(mime)) return null;
  const isImage = mime.startsWith('image/');
  if (isImage && b64.length > MAX_IMAGE_B64) return null;
  if (!isImage && b64.length > MAX_AUDIO_B64) return null;

  const id = uid() + Math.random().toString(36).slice(2, 6);
  const buf = Buffer.from(b64, 'base64');
  if (pool) {
    try {
      await pool.query('INSERT INTO yd_media (id, mime, data, ts) VALUES ($1,$2,$3,$4)', [id, mime, buf, Date.now()]);
    } catch (e) {
      console.error('Medya kaydedilemedi:', e.message);
      return null;
    }
  } else {
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_DIR, `${id}.${EXT[mime] || 'bin'}`), buf);
    } catch (e) {
      console.error('Medya dosyaya yazılamadı:', e.message);
      return null;
    }
  }
  return { id, url: '/media/' + id };
}

app.get('/media/:id', async (req, res) => {
  const id = String(req.params.id).replace(/[^a-z0-9]/gi, '');
  if (!id) return res.sendStatus(400);
  try {
    if (pool) {
      const r = await pool.query('SELECT mime, data FROM yd_media WHERE id = $1', [id]);
      if (!r.rows[0]) return res.sendStatus(404);
      res.set('Content-Type', r.rows[0].mime);
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(r.rows[0].data);
    }
    const files = fs.readdirSync(UPLOAD_DIR).filter((f) => f.startsWith(id + '.'));
    if (!files.length) return res.sendStatus(404);
    const ext = files[0].split('.').pop();
    res.set('Content-Type', MIME_BY_EXT[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(path.join(UPLOAD_DIR, files[0]));
  } catch (e) {
    res.sendStatus(500);
  }
});

/* ------------------------------------------------------------------ */
/*  YARDIMCILAR                                                       */
/* ------------------------------------------------------------------ */

const online = new Map();
const socketUser = new Map();
const joinTimes = new Map();

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const colorOk = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c) : '#fe2c55');

/* ---------------- şifreli hesaplar ---------------- */
const ADMIN_NAME = (process.env.ADMIN_NAME || 'deadbox1903').trim().toLowerCase();
const ADMIN_CODE = String(process.env.ADMIN_CODE || 'deadbox1903').trim().toLowerCase();
const nameKey = (n) => String(n || '').trim().toLowerCase();
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const newSalt = () => crypto.randomBytes(12).toString('hex');
const newToken = () => crypto.randomBytes(24).toString('hex');

function findUserByName(name) {
  const k = nameKey(name);
  if (!k) return null;
  return Object.values(db.users).find((u) => nameKey(u.name) === k) || null;
}
const isAdminName = (n) => nameKey(n) === ADMIN_NAME;

function groupInfo(thread, key) {
  const members = thread.uids.map((id) => {
    const u = db.users[id];
    return u ? pub(u) : { id, name: 'Ayrıldı', emoji: '👤', color: '#666666', online: false, lastSeen: 0 };
  });
  return { key, name: thread.name || 'Grup', uids: thread.uids.slice(), owner: thread.owner || null, members };
}

function pub(u) {
  return {
    id: u.id, name: u.name, city: u.city || '', emoji: u.emoji || '😎',
    color: u.color || '#fe2c55', online: (online.get(u.id) || 0) > 0, lastSeen: u.lastSeen || 0,
    isAdmin: !!u.isAdmin,
  };
}

function healAdmins() {
  for (const u of Object.values(db.users)) {
    if (isAdminName(u.name)) u.isAdmin = true;
  }
}

function presencePayload() {
  // aynı isim birden fazla kayıtta varsa tek göster (çevrimiçi olan kazanır)
  const byName = new Map();
  for (const u of Object.values(db.users)) {
    const p = pub(u);
    const key = nameKey(p.name);
    const cur = byName.get(key);
    if (!cur || (p.online && !cur.online) || (p.online === cur.online && (p.lastSeen || 0) > (cur.lastSeen || 0))) {
      byName.set(key, p);
    }
  }
  const list = [...byName.values()];
  list.sort((a, b) => (b.online === a.online ? b.lastSeen - a.lastSeen : b.online - a.online));
  return { users: list.slice(0, 400), online: list.filter((u) => u.online).length, total: list.length };
}

function broadcastPresence() { io.emit('presence', presencePayload()); }

function trimUsers() {
  const all = Object.values(db.users);
  if (all.length <= MAX_USERS) return;
  all.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  all.slice(MAX_USERS).forEach((u) => { if (!(online.get(u.id) > 0)) delete db.users[u.id]; });
}

const pairKey = (a, b) => [a, b].sort().join('__');

function getThread(a, b, create) {
  const key = pairKey(a, b);
  let t = db.dms[key];
  if (!t && create) t = db.dms[key] = { uids: [a, b].sort(), messages: [] };
  return t ? { key, thread: t } : null;
}

function peerReadTs(me, peerId) {
  const r = db.reads && db.reads[me];
  return (r && r[peerId]) || 0;
}

function dmListFor(userId) {
  const out = [];
  for (const [key, thread] of Object.entries(db.dms)) {
    if (!Array.isArray(thread.uids) || !thread.uids.includes(userId)) continue;
    if (!Array.isArray(thread.messages)) thread.messages = [];
    const isGroup = !!thread.isGroup;
    const peerId = isGroup ? key : thread.uids.find((x) => x !== userId);
    let peer;
    if (isGroup) {
      const onlineCount = thread.uids.filter((id) => (online.get(id) || 0) > 0).length;
      peer = { id: key, name: thread.name || 'Grup', emoji: '👥', color: '#8b5cf6', online: onlineCount > 0, lastSeen: 0, isAdmin: false };
    } else {
      const raw = db.users[peerId] || { id: peerId, name: 'Bilinmeyen', emoji: '👤', color: '#666666' };
      peer = pub(raw);
    }
    const last = thread.messages[thread.messages.length - 1] || null;
    out.push({
      key, peerId, peer, isGroup,
      memberCount: thread.uids.length,
      owner: thread.owner || null,
      last, updated: last ? last.ts : 0,
      peerRead: isGroup ? 0 : peerReadTs(userId, peerId),
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out.slice(0, 150);
}

function systemMessage(text) {
  const msg = { id: uid(), kind: 'system', text, ts: Date.now() };
  db.global.push(msg);
  if (db.global.length > MAX_GLOBAL) db.global = db.global.slice(-MAX_GLOBAL);
  io.emit('global:new', msg);
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/*  SOCKET.IO                                                         */
/* ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  let bucket = 0;
  const bucketReset = setInterval(() => (bucket = 0), 6000);
  socket.on('disconnect', () => clearInterval(bucketReset));

  async function buildMessage(base, payload) {
    const text = clean(payload && payload.text, 500);
    let image = null, audio = null;
    if (payload && payload.image) {
      const m = await storeMedia(payload.image);
      if (!m) { socket.emit('err', { message: 'Fotoğraf çok büyük veya desteklenmiyor.' }); return null; }
      image = m.url;
    }
    if (payload && payload.audio) {
      const m = await storeMedia(payload.audio);
      if (!m) { socket.emit('err', { message: 'Ses kaydı çok büyük veya desteklenmiyor.' }); return null; }
      audio = m.url;
    }
    if (!text && !image && !audio) return null;
    const msg = { id: uid(), ts: Date.now(), ...base };
    if (text) msg.text = text;
    if (image) msg.image = image;
    if (audio) msg.audio = audio;
    return msg;
  }

  // hız sınırı (6 saniyede en fazla 25 olay)
  function guard() {
    bucket++;
    if (bucket > 25) {
      socket.emit('err', { message: 'Çok hızlı yazıyorsun, biraz bekle 🙂' });
      return false;
    }
    return true;
  }

  /* ---------------- oturum açma ---------------- */
  function attach(socket, user, isNew) {
    const oldUserId = socketUser.get(socket.id);
    if (oldUserId && oldUserId !== user.id) {
      const c = (online.get(oldUserId) || 1) - 1;
      if (c > 0) online.set(oldUserId, c); else online.delete(oldUserId);
    }
    socketUser.set(socket.id, user.id);
    socket.data.userId = user.id;
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = 'u:' + user.id;
    socket.join(socket.data.room);
    online.set(user.id, (online.get(user.id) || 0) + 1);
    user.lastSeen = Date.now();
    if (isAdminName(user.name)) user.isAdmin = true;   // isim yönetici ise bayrak düzeltilir
    if (!Array.isArray(user.tokens)) user.tokens = [];

    socket.emit('auth:ok', { user: pub(user), token: socket.data.token || null });
    socket.emit('me', { user: pub(user) });
    socket.emit('global:history', db.global.slice(-200));
    socket.emit('dm:list', dmListFor(user.id));
    broadcastPresence();

    if (isNew) {
      const lastJoin = joinTimes.get(user.id) || 0;
      if (Date.now() - lastJoin > 60000) {
        joinTimes.set(user.id, Date.now());
        systemMessage(`${user.name}${user.city ? ' (' + user.city + ')' : ''} sohbete katıldı 👋`);
      }
    }
    trimUsers();
    scheduleSave();
  }

  socket.on('auth:register', (payload) => {
    if (!guard()) return;
    const p = payload || {};
    const name = clean(p.name, 24);
    const pass = String(p.password || '');
    const confirm = String(p.confirm || '');
    if (name.length < 2) return socket.emit('auth:err', { code: 'name_short', message: 'Kullanıcı adı en az 2 karakter olmalı.' });
    if (pass.length < 4) return socket.emit('auth:err', { code: 'pass_short', message: 'Şifre en az 4 karakter olmalı.' });
    if (pass !== confirm) return socket.emit('auth:err', { code: 'pass_mismatch', message: 'Şifreler uyuşmuyor.' });
    if (findUserByName(name)) return socket.emit('auth:err', { code: 'name_taken', message: 'Bu isim kullanılıyor — şifrenle giriş yap.' });

    const salt = newSalt();
    const user = {
      id: uid(), name, city: clean(p.city, 24), emoji: clean(p.emoji, 8) || '😎',
      color: colorOk(p.color), salt, passHash: hashPass(pass, salt),
      tokens: [newToken()], isAdmin: isAdminName(name), createdAt: Date.now(), lastSeen: Date.now(),
    };
    db.users[user.id] = user;
    socket.data.token = user.tokens[0];
    attach(socket, user, true);
  });

  socket.on('auth:login', (payload) => {
    if (!guard()) return;
    const p = payload || {};
    const user = findUserByName(p.name);
    if (!user) return socket.emit('auth:err', { code: 'no_user', message: 'Böyle bir hesap yok. "Yeni hesap" ile kayıt ol.' });
    if (!user.passHash) return socket.emit('auth:err', { code: 'no_pass', message: 'Bu hesabın henüz şifresi yok — şifre belirle.', needSetPass: true });
    if (hashPass(String(p.password || ''), user.salt) !== user.passHash) {
      return socket.emit('auth:err', { code: 'bad_pass', message: 'Şifre yanlış.' });
    }
    const token = newToken();
    user.tokens = [...(user.tokens || []).slice(-4), token];
    socket.data.token = token;
    attach(socket, user, false);
  });

  // eski (şifresiz) hesaplar için bir kerelik şifre belirleme
  socket.on('auth:setpass', (payload) => {
    if (!guard()) return;
    const p = payload || {};
    const user = findUserByName(p.name);
    if (!user) return socket.emit('auth:err', { code: 'no_user', message: 'Böyle bir hesap yok.' });
    if (user.passHash) return socket.emit('auth:err', { code: 'has_pass', message: 'Bu hesabın şifresi zaten var.' });
    const pass = String(p.password || '');
    const confirm = String(p.confirm || '');
    if (pass.length < 4) return socket.emit('auth:err', { code: 'pass_short', message: 'Şifre en az 4 karakter olmalı.' });
    if (pass !== confirm) return socket.emit('auth:err', { code: 'pass_mismatch', message: 'Şifreler uyuşmuyor.' });
    user.salt = newSalt();
    user.passHash = hashPass(pass, user.salt);
    const token = newToken();
    user.tokens = [token];
    socket.data.token = token;
    attach(socket, user, false);
  });

  socket.on('auth:token', (payload) => {
    const p = payload || {};
    const id = clean(p.uid, 64);
    const token = clean(p.token, 128);
    const user = id ? db.users[id] : null;
    if (!user || !Array.isArray(user.tokens) || !user.tokens.includes(token)) {
      return socket.emit('auth:need', { reason: 'token' });
    }
    socket.data.token = token;
    attach(socket, user, false);
  });

  socket.on('auth:rename', (payload) => {
    const me = socket.data.userId;
    const u = me && db.users[me];
    if (!u) return;
    const p = payload || {};
    const name = clean(p.name, 24);
    const pass = String(p.password || '');
    if (name.length < 2) return socket.emit('auth:err', { code: 'name_short', message: 'Kullanıcı adı en az 2 karakter olmalı.' });
    if (!u.passHash) return socket.emit('auth:err', { code: 'no_pass', message: 'Şifre belirlenmemiş.' });
    if (hashPass(pass, u.salt) !== u.passHash) return socket.emit('auth:err', { code: 'bad_pass', message: 'Şifre yanlış.' });
    const other = findUserByName(name);
    if (other && other.id !== u.id) return socket.emit('auth:err', { code: 'name_taken', message: 'Bu isim kullanılıyor.' });
    if (nameKey(u.name) === nameKey(name)) return socket.emit('err', { message: 'İsim aynı kaldı.' });
    u.name = name;
    if (isAdminName(name)) u.isAdmin = true;
    socket.emit('me', { user: pub(u) });
    socket.emit('auth:ok', { user: pub(u), token: socket.data.token || null });
    socket.emit('rename:ok', { name: u.name });
    broadcastPresence();
    scheduleSave();
  });

  /* ---------------- yönetici ---------------- */
  socket.on('admin:kick', (payload) => {
    const me = socket.data.userId;
    const mod = me && db.users[me];
    if (!mod || !mod.isAdmin) return socket.emit('err', { message: 'Bu işlem için yönetici olmalısın.' });
    const targetId = clean(payload && payload.userId, 64);
    const target = targetId && db.users[targetId];
    if (!target || target.id === me) return;
    if (target.isAdmin) return socket.emit('err', { message: 'Yönetici atılamaz.' });

    delete db.users[target.id];
    online.delete(target.id);
    for (const [sid, uidOf] of Array.from(socketUser.entries())) {
      if (uidOf !== target.id) continue;
      const s2 = io.sockets.sockets.get(sid);
      if (s2) {
        s2.emit('kicked', { by: mod.name });
        setTimeout(() => { try { s2.disconnect(true); } catch (e) {} }, 250);
      }
      socketUser.delete(sid);
    }
    broadcastPresence();
    for (const uidTo of Object.keys(db.users)) io.to('u:' + uidTo).emit('dm:list', dmListFor(uidTo));
    systemMessage(`⛔ ${target.name} yönetici tarafından sohbetten çıkarıldı.`);
    scheduleSave();
  });

  // kod ile yönetici olma (isim tutmasa bile)
  socket.on('admin:claim', (payload) => {
    const me = socket.data.userId;
    const u = me && db.users[me];
    if (!u) return;
    const code = String((payload && payload.code) || '').trim().toLowerCase();
    if (!code || code !== ADMIN_CODE) return socket.emit('err', { message: 'Yönetici kodu yanlış.' });
    u.isAdmin = true;
    socket.emit('me', { user: pub(u) });
    socket.emit('auth:ok', { user: pub(u), token: socket.data.token || null });
    socket.emit('toast:msg', { message: '👑 Artık yöneticisin!' });
    broadcastPresence();
    scheduleSave();
  });

  /* ---------------- grup sohbetleri ---------------- */
  socket.on('group:create', (payload) => {
    if (!guard()) return;
    const me = socket.data.userId;
    const u = me && db.users[me];
    if (!u) return;
    const p = payload || {};
    const name = clean(p.name, 30) || 'Yeni grup';
    const raw = Array.isArray(p.uids) ? p.uids : [];
    const uids = [...new Set([me, ...raw.map((x) => clean(x, 64)).filter((x) => x && db.users[x])])];
    if (uids.length < 2) return socket.emit('err', { message: 'Gruba en az bir kişi ekle.' });
    const key = 'g:' + uid();
    db.dms[key] = { isGroup: true, name, owner: me, uids, messages: [], createdAt: Date.now() };
    for (const id of uids) io.to('u:' + id).emit('dm:list', dmListFor(id));
    socket.emit('group:created', { key });
    scheduleSave();
  });

  socket.on('group:add', (payload) => {
    const me = socket.data.userId;
    const p = payload || {};
    const key = clean(p.key, 64);
    const t = key && db.dms[key];
    if (!t || !t.isGroup || !t.uids.includes(me)) return;
    if (t.owner !== me) return socket.emit('err', { message: 'Gruba sadece kurucu üye ekleyebilir.' });
    const add = (Array.isArray(p.uids) ? p.uids : []).map((x) => clean(x, 64)).filter((x) => x && db.users[x] && !t.uids.includes(x));
    if (!add.length) return;
    t.uids.push(...add);
    for (const id of t.uids) io.to('u:' + id).emit('dm:list', dmListFor(id));
    for (const id of t.uids) io.to('u:' + id).emit('group:updated', { key, group: groupInfo(t, key) });
    scheduleSave();
  });

  socket.on('global:send', async (payload) => {
    if (!guard()) return;
    const u = db.users[socket.data.userId];
    if (!u) return;
    const msg = await buildMessage(
      { kind: 'chat', from: u.id, name: u.name, city: u.city || '', emoji: u.emoji, color: u.color },
      payload
    );
    if (!msg) return;
    db.global.push(msg);
    if (db.global.length > MAX_GLOBAL) db.global = db.global.slice(-MAX_GLOBAL);
    io.emit('global:new', msg);
    scheduleSave();
  });

  socket.on('dm:open', (payload) => {
    const me = socket.data.userId;
    const peerId = clean(payload && payload.peerId, 64);
    if (!me || !peerId) return;
    if (peerId.startsWith('g:')) {
      const t = db.dms[peerId];
      if (!t || !t.isGroup || !t.uids.includes(me)) return;
      if (!Array.isArray(t.messages)) t.messages = [];
      return socket.emit('dm:history', {
        peerId, isGroup: true, group: groupInfo(t, peerId), messages: t.messages, peerRead: 0,
      });
    }
    if (peerId === me) return;
    const t = getThread(me, peerId, false);
    socket.emit('dm:history', {
      peerId,
      messages: t ? t.thread.messages : [],
      peerRead: peerReadTs(me, peerId),
    });
  });

  socket.on('dm:send', async (payload) => {
    if (!guard()) return;
    const me = socket.data.userId;
    const u = db.users[me];
    const peerId = clean(payload && payload.to, 64);
    if (!u || !peerId) return;

    if (peerId.startsWith('g:')) {
      const t = db.dms[peerId];
      if (!t || !t.isGroup || !t.uids.includes(me)) return;
      const gmsg = await buildMessage(
        { kind: 'dm', from: me, to: peerId, name: u.name, emoji: u.emoji, color: u.color }, payload
      );
      if (!gmsg) return;
      t.messages.push(gmsg);
      if (t.messages.length > MAX_THREAD) t.messages = t.messages.slice(-MAX_THREAD);
      for (const id of t.uids) io.to('u:' + id).emit('dm:new', gmsg);
      scheduleSave();
      return;
    }

    if (peerId === me) return;
    if (!db.users[peerId]) { socket.emit('err', { message: 'Bu kullanıcı artık yok.' }); return; }

    const msg = await buildMessage(
      { kind: 'dm', from: me, to: peerId, name: u.name, emoji: u.emoji, color: u.color },
      payload
    );
    if (!msg) return;

    const { thread } = getThread(me, peerId, true);
    thread.messages.push(msg);
    if (thread.messages.length > MAX_THREAD) thread.messages = thread.messages.slice(-MAX_THREAD);
    io.to('u:' + me).to('u:' + peerId).emit('dm:new', msg);
    scheduleSave();
  });

  // ---- görüldü ----
  socket.on('dm:read', (payload) => {
    const me = socket.data.userId;
    const peerId = clean(payload && payload.peerId, 64);
    if (!me || !peerId || peerId === me) return;
    if (peerId.startsWith('g:')) return;   // gruplarda "görüldü" yok
    if (!db.reads[me]) db.reads[me] = {};
    db.reads[me][peerId] = Date.now();
    io.to('u:' + peerId).emit('dm:read', { by: me, peerId, ts: db.reads[me][peerId] });
    scheduleSave();
  });

  // ---- mesaj silme (sadece kendi mesajı) ----
  socket.on('msg:delete', (payload) => {
    const me = socket.data.userId;
    const id = clean(payload && payload.id, 64);
    const scope = payload && payload.scope === 'dm' ? 'dm' : 'global';
    if (!me || !id) return;

    if (scope === 'global') {
      const i = db.global.findIndex((x) => x.id === id);
      if (i === -1 || db.global[i].from !== me) return;
      db.global.splice(i, 1);                       // mesaj tamamen yok oldu
      io.emit('msg:deleted', { scope: 'global', id });
      scheduleSave();
      return;
    }

    for (const [key, thread] of Object.entries(db.dms)) {
      const i = thread.messages.findIndex((x) => x.id === id);
      if (i === -1) continue;
      if (thread.messages[i].from !== me) return;
      thread.messages.splice(i, 1);                 // mesaj tamamen yok oldu
      if (!thread.messages.length) { delete db.dms[key]; } // boş sohbet de silinsin
      for (const uidTo of thread.uids) io.to('u:' + uidTo).emit('msg:deleted', { scope: 'dm', id });
      // sohbet listesindeki son mesaj önizlemesi tazelensin
      for (const uidTo of thread.uids) {
        io.to('u:' + uidTo).emit('dm:list', dmListFor(uidTo));
      }
      scheduleSave();
      return;
    }
  });

  socket.on('typing', (payload) => {
    const me = socket.data.userId;
    const u = db.users[me];
    if (!u) return;
    const to = clean(payload && payload.to, 64);
    const info = { from: me, name: u.name, emoji: u.emoji, color: u.color, ts: Date.now() };
    if (to && to.startsWith('g:')) {
      const t = db.dms[to];
      if (!t || !t.isGroup || !t.uids.includes(me)) return;
      for (const id of t.uids) if (id !== me) io.to('u:' + id).emit('typing', { ...info, scope: 'dm', to });
    } else if (to) socket.to('u:' + to).emit('typing', { ...info, scope: 'dm' });
    else socket.broadcast.emit('typing', { ...info, scope: 'global' });
  });

  socket.on('disconnect', () => {
    clearInterval(bucketReset);
    const userId = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    if (!userId) return;
    const c = (online.get(userId) || 1) - 1;
    if (c > 0) online.set(userId, c); else online.delete(userId);
    if (db.users[userId]) db.users[userId].lastSeen = Date.now();
    broadcastPresence();
    scheduleSave();
  });
});

/* ------------------------------------------------------------------ */
/*  HTTP yardımcıları                                                 */
/* ------------------------------------------------------------------ */

function maskUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      user: u.username || '(yok)',
      password: u.password ? '****' : '(yok)',
      host: u.hostname,
      port: u.port || '5432',
      database: u.pathname.replace(/^\//, '') || '(yok)',
      sslmode: u.searchParams.get('sslmode') || '(yok)',
      channel_binding: u.searchParams.get('channel_binding') || '(yok)',
      startsWith: url.slice(0, 13),
      length: url.length,
      hasSpaces: /\s/.test(url),
      hasQuotes: /["']/.test(url),
    };
  } catch (e) {
    return { parseError: e.message, startsWith: String(url).slice(0, 13), length: String(url).length };
  }
}

app.get('/api/durum', (_req, res) => {
  healAdmins();
  const users = Object.values(db.users).map((u) => ({
    name: u.name, isAdmin: !!u.isAdmin, online: (online.get(u.id) || 0) > 0, lastSeen: u.lastSeen || 0,
  }));
  users.sort((a, b) => (b.online - a.online) || (b.lastSeen - a.lastSeen));
  const groups = Object.entries(db.dms).filter(([, t]) => t.isGroup)
    .map(([key, t]) => ({ key, name: t.name, members: t.uids.map((id) => (db.users[id] ? db.users[id].name : 'ayrıldı')), messages: t.messages.length }));
  res.json({ users, groups, adminName: ADMIN_NAME, counts: { users: users.length, groups: groups.length } });
});

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    storage: storageMode,
    persistent: storageMode === 'postgres',
    users: Object.keys(db.users).length,
    messages: db.global.length,
    threads: Object.keys(db.dms).length,
    online: [...online.keys()].length,
    features: ['photo', 'voice', 'delete', 'read', 'online', 'accounts', 'admin', 'groups'],
    dbUrlFound: !!process.env.DATABASE_URL,
    dbUrl: maskUrl(process.env.DATABASE_URL),
    dbError: dbError,
    node: process.version,
  })
);

app.get('/dbtest', async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ ok: false, problem: 'DATABASE_URL tanımlı değil' });
  }
  try {
    const { Pool } = require('pg');
    const useSSL = String(process.env.PGSSL || '').toLowerCase() !== 'disable';
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 15000, max: 1 });
    const t0 = Date.now();
    const v = await p.query('SELECT version() AS v');
    await p.query('CREATE TABLE IF NOT EXISTS yd_probe (id int PRIMARY KEY, note text)');
    await p.query("INSERT INTO yd_probe (id, note) VALUES (1, 'ok') ON CONFLICT (id) DO UPDATE SET note = 'ok'");
    const r = await p.query('SELECT note FROM yd_probe WHERE id = 1');
    await p.end();
    res.json({ ok: true, ms: Date.now() - t0, postgres: String(v.rows[0].v).slice(0, 40), writeRead: r.rows[0].note });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, code: e.code, dbUrl: maskUrl(process.env.DATABASE_URL) });
  }
});

app.get('/kontrol', (_req, res) => {
  const h = maskUrl(process.env.DATABASE_URL);
  const ok = storageMode === 'postgres';
  const hasUrl = !!process.env.DATABASE_URL;
  const rows = (obj) => Object.entries(obj || {}).map(([k, v]) => `<tr><td>${k}</td><td><code>${String(v)}</code></td></tr>`).join('');
  let sorun = '';
  if (!hasUrl) sorun = `<b>DATABASE_URL değişkeni sunucuya hiç ulaşmamış.</b><br>Render → <b>Environment</b> → <code>DATABASE_URL</code> → Save Changes.`;
  else if (h && h.parseError) sorun = `<b>Adres bozuk görünüyor.</b> <code>postgresql://</code> ile başlamalı.`;
  else if (h && (h.hasSpaces || h.hasQuotes)) sorun = `<b>Adreste boşluk veya tırnak var.</b> Tekrar kopyala-yapıştır yap.`;
  else if (dbError) sorun = `<b>Veritabanına bağlanılamadı.</b><br><code>${dbError}</code>`;
  else if (!ok) sorun = 'Bağlantı denemesi sürüyor… yenile.';

  res.type('html').send(`<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Yerel Dedikodu — Sistem Kontrolü</title>
<style>
 body{margin:0;background:#08080c;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
 .wrap{max-width:640px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8b8b9e;font-size:13px;margin-bottom:20px}
 .card{border-radius:18px;padding:20px;margin-bottom:14px;background:#12121a;border:1px solid rgba(255,255,255,.09)}
 .big{font-size:22px;font-weight:800}.ok{background:linear-gradient(135deg,rgba(46,230,168,.16),rgba(46,230,168,.04));border-color:rgba(46,230,168,.5)}
 .ok .big{color:#2ee6a8}.bad{background:linear-gradient(135deg,rgba(254,44,85,.16),rgba(254,44,85,.04));border-color:rgba(254,44,85,.5)}
 .bad .big{color:#fe2c55}.fix{margin-top:14px;font-size:14px;line-height:1.65}
 .ok-soft{background:linear-gradient(135deg,rgba(46,230,168,.10),rgba(46,230,168,.02));border-color:rgba(46,230,168,.35)}
 table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#b9b9c9}
 td:first-child{width:45%;color:#8b8b9e}code{background:#1d1d28;padding:2px 6px;border-radius:6px;font-size:12.5px;color:#25f4ee;word-break:break-all}
 .btn{display:inline-block;margin-top:8px;background:linear-gradient(135deg,#fe2c55,#ff5c7a);color:#fff;text-decoration:none;padding:12px 20px;border-radius:12px;font-weight:800;font-size:14px}
 .muted{color:#6a6a7e;font-size:12px;margin-top:10px;line-height:1.6}
 .pill{font-size:11px;background:rgba(255,255,255,.08);padding:3px 9px;border-radius:999px;color:#c9c9d6;font-weight:600}
</style></head><body><div class="wrap">
<h1>💬 Yerel Dedikodu — Sistem Kontrolü</h1>
<div class="sub">Sohbet geçmişinin kalıcı olup olmadığını gösterir.</div>
<div class="card ${ok ? 'ok' : 'bad'}">
  <div class="big">${ok ? '✅ Sohbetler KALICI' : '❌ Veritabanı bağlı değil'}</div>
  <div class="fix">${ok ? 'Mesajlar, fotoğraflar ve ses kayıtları PostgreSQL veritabanına kaydediliyor. Sunucu yeniden başlasa da <b>hiçbir şey silinmez</b>.' : sorun}</div>
  ${ok ? '' : '<a class="btn" href="/dbtest">🔍 Bağlantıyı test et</a>'}
</div>
<div class="card"><div class="big" style="font-size:15px">📊 Durum</div><table>
  <tr><td>Depolama</td><td><code>${storageMode}</code> ${ok ? '<span class="pill">kalıcı</span>' : '<span class="pill">geçici</span>'}</td></tr>
  <tr><td>Çalışma süresi</td><td><code>${Math.round(process.uptime())} sn</code></td></tr>
  <tr><td>Kullanıcı / mesaj / DM</td><td><code>${Object.keys(db.users).length} / ${db.global.length} / ${Object.keys(db.dms).length}</code></td></tr>
  <tr><td>Şu an çevrimiçi</td><td><code>${[...online.keys()].length}</code></td></tr>
</table></div>
${h ? `<div class="card"><div class="big" style="font-size:15px">🔐 Adres kontrolü <span class="pill">şifre gizli</span></div>
<table>${rows({ baslangic: h.startsWith, uzunluk: h.length + ' karakter', kullanici: h.user, sifre: h.password, sunucu: h.host, port: h.port, veritabani: h.database, sslmode: h.sslmode, bosluk_var: h.hasSpaces ? 'EVET (sorun!)' : 'hayır', tirnak_var: h.hasQuotes ? 'EVET (sorun!)' : 'hayır' })}</table>
<div class="muted">Şifre asla gösterilmez, bu ekran görüntüsünü paylaşabilirsin.</div></div>` : ''}
${ok ? `<div class="card ok-soft"><div class="big" style="font-size:15px;color:#2ee6a8">🎉 Her şey yolunda</div>
<div class="fix">Render → Manual Deploy → Restart yap, sonra bu sayfayı yenile: mesaj sayıları <b>aynı</b> kalacak.</div></div>`
: `<div class="card"><div class="big" style="font-size:15px">📖 Ne yapmalıyım?</div>
<div class="fix"><b>1.</b> Neon.com → Connect → adresi kopyala<br><b>2.</b> Render → Environment → <code>DATABASE_URL</code><br>
<b>3.</b> Save Changes → 1-2 dk bekle<br><b>4.</b> Bu sayfayı yenile</div></div>`}
</div></body></html>`);
});

initStorage().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Yerel Dedikodu ${PORT} portunda yayında — depolama: ${storageMode}`);
  });
});
