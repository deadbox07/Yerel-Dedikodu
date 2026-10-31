const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e6,
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const DATA_FILE = path.join(__dirname, 'data.json');
const MAX_GLOBAL = 400;
const MAX_THREAD = 300;
const MAX_USERS = 600;

let db = { users: {}, global: [], dms: {} };
let pool = null;              // varsa PostgreSQL bağlantı havuzu
let storageMode = 'file';     // 'postgres' | 'file'
let saveTimer = null;
let dirty = false;

/* ------------------------------------------------------------------ */
/*  DEPOLAMA: PostgreSQL varsa kalıcı, yoksa data.json                */
/* ------------------------------------------------------------------ */

function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    users: p.users && typeof p.users === 'object' ? p.users : {},
    global: Array.isArray(p.global) ? p.global.slice(-MAX_GLOBAL) : [],
    dms: p.dms && typeof p.dms === 'object' ? p.dms : {},
  };
}

function loadFile() {
  try {
    db = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    console.log('💾 Veri data.json dosyasından yüklendi');
  } catch (e) {
    /* ilk çalıştırma */
  }
}

async function initStorage() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    loadFile();
    storageMode = 'file';
    console.log('⚠️  DATABASE_URL yok → sohbet geçmişi sadece sunucu açıkken korunur (data.json)');
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
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const r = await pool.query("SELECT value FROM yd_state WHERE key = 'db'");
    if (r.rows[0]) db = normalize(r.rows[0].value);
    storageMode = 'postgres';
    console.log('✅ PostgreSQL bağlı — sohbet geçmişi KALICI');
  } catch (e) {
    console.error('❌ Veritabanına bağlanılamadı:', e.message);
    console.error('   → dosya moduna geçildi (geçmiş kalıcı olmayacak)');
    if (pool) { try { await pool.end(); } catch (_) {} }
    pool = null;
    storageMode = 'file';
    loadFile();
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
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  } catch (e) {
    console.error('Kayıt hatası (dosya):', e.message);
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 600);
}

// düzenli yedekleme (ani kapanmalara karşı)
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
/*  YARDIMCILAR                                                       */
/* ------------------------------------------------------------------ */

const online = new Map();     // userId -> açık sekme sayısı
const socketUser = new Map(); // socketId -> userId
const joinTimes = new Map();  // userId -> en son katılma zamanı

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const clean = (v, max) =>
  String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
const colorOk = (c) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? String(c) : '#fe2c55');

function pub(u) {
  return {
    id: u.id,
    name: u.name,
    city: u.city || '',
    emoji: u.emoji || '😎',
    color: u.color || '#fe2c55',
    online: (online.get(u.id) || 0) > 0,
    lastSeen: u.lastSeen || 0,
  };
}

function presencePayload() {
  const list = Object.values(db.users).map(pub);
  list.sort((a, b) => (b.online === a.online ? b.lastSeen - a.lastSeen : b.online - a.online));
  return { users: list.slice(0, 400), online: list.filter((u) => u.online).length, total: list.length };
}

function broadcastPresence() {
  io.emit('presence', presencePayload());
}

function trimUsers() {
  const all = Object.values(db.users);
  if (all.length <= MAX_USERS) return;
  all.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  all.slice(MAX_USERS).forEach((u) => {
    if (!(online.get(u.id) > 0)) delete db.users[u.id];
  });
}

function pairKey(a, b) {
  return [a, b].sort().join('__');
}

function getThread(a, b, create) {
  const key = pairKey(a, b);
  let t = db.dms[key];
  if (!t && create) t = db.dms[key] = { uids: [a, b].sort(), messages: [] };
  return t ? { key, thread: t } : null;
}

function dmListFor(userId) {
  const out = [];
  for (const [key, thread] of Object.entries(db.dms)) {
    if (!Array.isArray(thread.uids) || !thread.uids.includes(userId)) continue;
    const peerId = thread.uids.find((x) => x !== userId);
    const peer = db.users[peerId] || { id: peerId, name: 'Bilinmeyen', emoji: '👤', color: '#666666' };
    const last = thread.messages[thread.messages.length - 1] || null;
    out.push({ key, peerId, peer: pub(peer), last, updated: last ? last.ts : 0 });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out.slice(0, 120);
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

  socket.on('hello', (payload) => {
    const p = payload || {};
    const userId = clean(p.userId, 64) || uid();
    const name = clean(p.name, 24) || 'Misafir';
    const city = clean(p.city, 24);
    const emoji = clean(p.emoji, 8) || '😎';
    const color = colorOk(p.color);

    const prev = db.users[userId];
    const isNew = !prev || prev.name !== name;
    db.users[userId] = { id: userId, name, city, emoji, color, lastSeen: Date.now() };

    const oldUserId = socketUser.get(socket.id);
    if (oldUserId && oldUserId !== userId) {
      const c = (online.get(oldUserId) || 1) - 1;
      if (c > 0) online.set(oldUserId, c);
      else online.delete(oldUserId);
    }

    socketUser.set(socket.id, userId);
    socket.data.userId = userId;
    if (socket.data.room) socket.leave(socket.data.room);
    socket.data.room = 'u:' + userId;
    socket.join(socket.data.room);

    online.set(userId, (online.get(userId) || 0) + 1);

    socket.emit('me', { user: pub(db.users[userId]) });
    socket.emit('global:history', db.global.slice(-200));
    socket.emit('dm:list', dmListFor(userId));
    broadcastPresence();

    const lastJoin = joinTimes.get(userId) || 0;
    if (isNew && Date.now() - lastJoin > 60000) {
      joinTimes.set(userId, Date.now());
      const where = city ? ` (${city})` : '';
      systemMessage(`${name}${where} sohbete katıldı 👋`);
    }
    trimUsers();
    scheduleSave();
  });

  function guard() {
    if (!socket.data.userId) return false;
    bucket++;
    if (bucket > 12) {
      socket.emit('err', { message: 'Çok hızlı yazıyorsun, biraz bekle 🙂' });
      return false;
    }
    return true;
  }

  socket.on('global:send', (payload) => {
    if (!guard()) return;
    const u = db.users[socket.data.userId];
    if (!u) return;
    const text = clean(payload && payload.text, 500);
    if (!text) return;
    const msg = {
      id: uid(),
      kind: 'chat',
      from: u.id,
      name: u.name,
      city: u.city || '',
      emoji: u.emoji,
      color: u.color,
      text,
      ts: Date.now(),
    };
    db.global.push(msg);
    if (db.global.length > MAX_GLOBAL) db.global = db.global.slice(-MAX_GLOBAL);
    io.emit('global:new', msg);
    scheduleSave();
  });

  socket.on('dm:open', (payload) => {
    const me = socket.data.userId;
    const peerId = clean(payload && payload.peerId, 64);
    if (!me || !peerId || peerId === me) return;
    const t = getThread(me, peerId, false);
    socket.emit('dm:history', { peerId, messages: t ? t.thread.messages : [] });
  });

  socket.on('dm:send', (payload) => {
    if (!guard()) return;
    const me = socket.data.userId;
    const u = db.users[me];
    const peerId = clean(payload && payload.to, 64);
    const text = clean(payload && payload.text, 500);
    if (!u || !peerId || !text || peerId === me) return;
    if (!db.users[peerId]) {
      socket.emit('err', { message: 'Bu kullanıcı artık yok.' });
      return;
    }
    const { thread } = getThread(me, peerId, true);
    const msg = {
      id: uid(),
      kind: 'dm',
      from: me,
      to: peerId,
      name: u.name,
      emoji: u.emoji,
      color: u.color,
      text,
      ts: Date.now(),
    };
    thread.messages.push(msg);
    if (thread.messages.length > MAX_THREAD) thread.messages = thread.messages.slice(-MAX_THREAD);
    io.to('u:' + me).to('u:' + peerId).emit('dm:new', msg);
    scheduleSave();
  });

  socket.on('typing', (payload) => {
    const me = socket.data.userId;
    const u = db.users[me];
    if (!u) return;
    const to = clean(payload && payload.to, 64);
    const info = { from: me, name: u.name, emoji: u.emoji, color: u.color, ts: Date.now() };
    if (to) socket.to('u:' + to).emit('typing', { ...info, scope: 'dm' });
    else socket.broadcast.emit('typing', { ...info, scope: 'global' });
  });

  socket.on('disconnect', () => {
    clearInterval(bucketReset);
    const userId = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    if (!userId) return;
    const c = (online.get(userId) || 1) - 1;
    if (c > 0) online.set(userId, c);
    else online.delete(userId);
    if (db.users[userId]) db.users[userId].lastSeen = Date.now();
    broadcastPresence();
    scheduleSave();
  });
});

/* ------------------------------------------------------------------ */
/*  HTTP                                                              */
/* ------------------------------------------------------------------ */

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    uptime: process.uptime(),
    storage: storageMode,               // 'postgres' → geçmiş kalıcı
    persistent: storageMode === 'postgres',
    users: Object.keys(db.users).length,
    messages: db.global.length,
    threads: Object.keys(db.dms).length,
  })
);

initStorage().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Yerel Dedikodu ${PORT} portunda yayında (0.0.0.0) — depolama: ${storageMode}`);
  });
});
