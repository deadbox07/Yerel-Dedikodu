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
let dbError = null;      // son bağlantı hatası (teşhis için)
let dbRetryTimer = null; // bağlantı kurulamazsa tekrar dene

/* ------------------------------------------------------------------ */
/*  DEPOLAMA: PostgreSQL varsa kalıcı, yoksa data.json                */
/* ------------------------------------------------------------------ */

function maskUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const pass = u.password ? '****' : '(yok)';
    return {
      user: u.username || '(yok)',
      password: pass,
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
    dbError = null;
    console.log('✅ PostgreSQL bağlı — sohbet geçmişi KALICI');
    if (dbRetryTimer) { clearInterval(dbRetryTimer); dbRetryTimer = null; }
  } catch (e) {
    dbError = e.message || String(e);
    console.error('❌ Veritabanına bağlanılamadı:', dbError);
    console.error('   → dosya moduna geçildi (geçmiş kalıcı olmayacak)');
    if (pool) { try { await pool.end(); } catch (_) {} }
    pool = null;
    storageMode = 'file';
    loadFile();
    // her 60 saniyede bir tekrar bağlanmayı dene (düzeltince yeniden başlatmaya gerek kalmaz)
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
/*  /kontrol : insan diliyle teşhis sayfası                           */
/* ------------------------------------------------------------------ */

function kontrolHtml() {
  const h = maskUrl(process.env.DATABASE_URL);
  const ok = storageMode === 'postgres';
  const hasUrl = !!process.env.DATABASE_URL;
  const rows = (obj) =>
    Object.entries(obj || {})
      .map(([k, v]) => `<tr><td>${k}</td><td><code>${String(v)}</code></td></tr>`)
      .join('');

  let sorun = '';
  if (!hasUrl) {
    sorun = `<b>DATABASE_URL değişkeni sunucuya hiç ulaşmamış.</b><br>
      Render → <b>yerel-dedikodu</b> → <b>Environment</b> → <code>DATABASE_URL</code> satırına
      Neon adresini yaz → <b>Save Changes</b> → deploy bitince bu sayfayı yenile.`;
  } else if (h && h.parseError) {
    sorun = `<b>Adres bozuk görünüyor.</b> Başında/sonunda tırnak, boşluk veya fazladan kelime olabilir.
      Adres <code>postgresql://</code> ile başlamalı, sonunda <code>?sslmode=require</code> olmalı.`;
  } else if (h && (h.hasSpaces || h.hasQuotes)) {
    sorun = `<b>Adreste boşluk veya tırnak işareti var.</b> Değeri baştan sona tekrar kopyala-yapıştır yap
      (başında/sonunda boşluk, <code>"</code> veya <code>'</code> olmasın).`;
  } else if (dbError) {
    sorun = `<b>Veritabanına bağlanılamadı.</b><br><code>${dbError}</code><br>
      En sık sebep: şifre/adres yanlış kopyalanmış ya da adresin sonunda <code>?sslmode=require</code> eksik.
      Neon panelinde <b>Connect</b> → <b>Connection string</b> ile yeniden kopyala.`;
  } else if (!ok) {
    sorun = 'Bağlantı denemesi sürüyor… 10 saniye sonra yenile.';
  }

  return `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Yerel Dedikodu — Sistem Kontrolü</title>
<style>
 body{margin:0;background:#08080c;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:24px}
 .wrap{max-width:640px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8b8b9e;font-size:13px;margin-bottom:20px}
 .card{border-radius:18px;padding:20px;margin-bottom:14px;background:#12121a;border:1px solid rgba(255,255,255,.09)}
 .big{font-size:22px;font-weight:800;display:flex;align-items:center;gap:10px}
 .ok{background:linear-gradient(135deg,rgba(46,230,168,.16),rgba(46,230,168,.04));border-color:rgba(46,230,168,.5)}
 .ok .big{color:#2ee6a8}
 .bad{background:linear-gradient(135deg,rgba(254,44,85,.16),rgba(254,44,85,.04));border-color:rgba(254,44,85,.5)}
 .bad .big{color:#fe2c55}
 .fix{margin-top:14px;font-size:14px;line-height:1.65;color:#e6e6f0}
 .fix code{background:#1d1d28;padding:2px 6px;border-radius:6px;font-size:12.5px;color:#25f4ee}
 table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
 td{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#b9b9c9}
 td:first-child{width:45%;color:#8b8b9e}
 code{background:#1d1d28;padding:2px 6px;border-radius:6px;font-size:12.5px;color:#25f4ee;word-break:break-all}
 .btn{display:inline-block;margin-top:8px;background:linear-gradient(135deg,#fe2c55,#ff5c7a);color:#fff;text-decoration:none;
      padding:12px 20px;border-radius:12px;font-weight:800;font-size:14px}
 .muted{color:#6a6a7e;font-size:12px;margin-top:10px;line-height:1.6}
 .pill{font-size:11px;background:rgba(255,255,255,.08);padding:3px 9px;border-radius:999px;color:#c9c9d6;font-weight:600}
</style></head><body><div class="wrap">
 <h1>💬 Yerel Dedikodu — Sistem Kontrolü</h1>
 <div class="sub">Bu sayfa sohbet geçmişinin kalıcı olup olmadığını gösterir.</div>

 <div class="card ${ok ? 'ok' : 'bad'}">
   <div class="big">${ok ? '✅ Sohbetler KALICI' : '❌ Veritabanı bağlı değil'}</div>
   <div class="fix">
     ${ok
       ? 'Mesajlar PostgreSQL veritabanına kaydediliyor. Sunucu yeniden başlasa, uykuya dalsa veya yeni sürüm yüklense bile <b>hiçbir mesaj silinmez</b>.'
       : sorun}
   </div>
   ${ok ? '' : '<a class="btn" href="/dbtest">🔍 Bağlantıyı test et</a>'}
 </div>

 <div class="card">
   <div class="big" style="font-size:15px;color:#c9c9d6">📊 Durum</div>
   <table>
     <tr><td>Depolama</td><td><code>${storageMode}</code> ${ok ? '<span class="pill">kalıcı</span>' : '<span class="pill">geçici</span>'}</td></tr>
     <tr><td>Sunucu çalışma süresi</td><td><code>${Math.round(process.uptime())} sn</code></td></tr>
     <tr><td>Kullanıcı / mesaj / DM</td><td><code>${Object.keys(db.users).length} / ${db.global.length} / ${Object.keys(db.dms).length}</code></td></tr>
     <tr><td>DATABASE_URL bulundu mu</td><td><code>${hasUrl ? 'EVET' : 'HAYIR'}</code></td></tr>
     ${dbError ? `<tr><td>Son hata</td><td><code style="color:#ff8fa3">${dbError}</code></td></tr>` : ''}
   </table>
 </div>

 ${h ? `<div class="card">
   <div class="big" style="font-size:15px;color:#c9c9d6">🔐 Adres kontrolü <span class="pill">şifre gizli</span></div>
   <table>${rows({ baslangic: h.startsWith, uzunluk: h.length + ' karakter', kullanici: h.user, sifre: h.password, sunucu: h.host, port: h.port, veritabani: h.database, sslmode: h.sslmode, bosluk_var: h.hasSpaces ? 'EVET (sorun!)' : 'hayır', tirnak_var: h.hasQuotes ? 'EVET (sorun!)' : 'hayır' })}</table>
   <div class="muted">Şifre asla gösterilmez. Bu sayfayı ekran görüntüsü olarak paylaşabilirsin, güvenlidir.</div>
 </div>` : ''}

 <div class="card">
   <div class="big" style="font-size:15px;color:#c9c9d6">📖 Ne yapmalıyım?</div>
   <div class="fix" style="font-size:13.5px">
     <b>1.</b> Neon.com → projen → <b>Connect</b> → Connection string'i kopyala<br>
     <b>2.</b> Render.com → servis → <b>Environment</b> → <code>DATABASE_URL</code> satırına yapıştır<br>
     <b>3.</b> <b>Save Changes</b> → deploy bitene kadar bekle (1-2 dk)<br>
     <b>4.</b> Bu sayfayı yenile → yeşil kutuyu gör
   </div>
   <div class="muted">Adres şu şekilde olmalı: <code>postgresql://kullanici:sifre@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require</code></div>
 </div>
</div></body></html>`;
}

app.get('/kontrol', (_req, res) => res.type('html').send(kontrolHtml()));

/* ------------------------------------------------------------------ */
/*  HTTP                                                              */
/* ------------------------------------------------------------------ */

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    storage: storageMode,               // 'postgres' → geçmiş kalıcı
    persistent: storageMode === 'postgres',
    users: Object.keys(db.users).length,
    messages: db.global.length,
    threads: Object.keys(db.dms).length,
    // ---- teşhis (şifre asla gösterilmez) ----
    dbUrlFound: !!process.env.DATABASE_URL,
    dbUrl: maskUrl(process.env.DATABASE_URL),
    dbError: dbError,
    node: process.version,
  })
);

// canlı veritabanı testi: gerçekten yazıp okuyor mu?
app.get('/dbtest', async (_req, res) => {
  if (!process.env.DATABASE_URL) {
    return res.status(400).json({ ok: false, problem: 'DATABASE_URL tanımlı değil (Environment değişkeni eklenmemiş/kaydedilmemiş)' });
  }
  try {
    const { Pool } = require('pg');
    const useSSL = String(process.env.PGSSL || '').toLowerCase() !== 'disable';
    const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 15000, max: 1 });
    const t0 = Date.now();
    const v = await p.query('SELECT version() AS v, now() AS t');
    await p.query('CREATE TABLE IF NOT EXISTS yd_probe (id int PRIMARY KEY, note text)');
    await p.query("INSERT INTO yd_probe (id, note) VALUES (1, 'ok') ON CONFLICT (id) DO UPDATE SET note = 'ok'");
    const r = await p.query('SELECT note FROM yd_probe WHERE id = 1');
    await p.end();
    res.json({ ok: true, ms: Date.now() - t0, postgres: String(v.rows[0].v).slice(0, 40), writeRead: r.rows[0].note, host: maskUrl(process.env.DATABASE_URL).host });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, code: e.code, dbUrl: maskUrl(process.env.DATABASE_URL) });
  }
});

initStorage().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Yerel Dedikodu ${PORT} portunda yayında (0.0.0.0) — depolama: ${storageMode}`);
  });
});
