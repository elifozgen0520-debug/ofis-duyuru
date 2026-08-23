const express = require('express');
const webpush = require('web-push');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Sadece JPG, PNG veya PDF yükleyebilirsiniz.'), ok);
  },
});

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, 'avatar-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Sadece JPG, PNG veya WEBP yükleyebilirsiniz.'), ok);
  },
});

function attachmentFromFile(file) {
  if (!file) return null;
  return {
    url: '/uploads/' + file.filename,
    type: file.mimetype === 'application/pdf' ? 'pdf' : 'image',
    name: file.originalname,
  };
}

// ============================================================================
// KALICI DEPOLAMA: Upstash Redis (ücretsiz, ömür boyu kalıcı)
// Render'ın ücretsiz planı dosya sistemi her deploy/uyku sonrası sıfırlandığı
// için (ephemeral filesystem), gerçek verileri (abonelikler, duyurular, vb.)
// Upstash Redis'te tutuyoruz. UPSTASH_REDIS_REST_URL ve
// UPSTASH_REDIS_REST_TOKEN ortam değişkenleri tanımlı değilse, geliştirme
// kolaylığı için yerel dosyaya düşer (fallback) — ama Render'da BUNLAR
// MUTLAKA tanımlı olmalı, yoksa veriler yine kalıcı olmaz.
// ============================================================================
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = (UPSTASH_URL && UPSTASH_TOKEN) ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }) : null;

if (!redis) {
  console.warn('\n⚠️  UYARI: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tanımlı değil.');
  console.warn('⚠️  Veriler KALICI OLMAYACAK — her deploy/uyku sonrası sıfırlanacak!');
  console.warn('⚠️  Render Environment sekmesinden bu iki değişkeni ekleyin.\n');
}

async function loadJson(key, def) {
  const fallback = def !== undefined ? def : [];
  if (redis) {
    try {
      const val = await redis.get(key);
      if (val === null || val === undefined) return fallback;
      // Upstash bazen otomatik parse edip obje/array döner, bazen string döner — ikisini de destekle.
      return (typeof val === 'string') ? JSON.parse(val) : val;
    } catch (err) {
      console.error('Redis okuma hatası (' + key + '):', err.message);
      return fallback;
    }
  }
  // Fallback: yerel dosya (sadece Upstash yapılandırılmamışsa)
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, key + '.json'), 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(key, data) {
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(data));
      return;
    } catch (err) {
      console.error('Redis yazma hatası (' + key + '):', err.message);
      return;
    }
  }
  // Fallback: yerel dosya
  try {
    fs.writeFileSync(path.join(__dirname, key + '.json'), JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Dosya yazma hatası (' + key + '):', err.message);
  }
}

const SUBS_KEY = 'subscriptions';
const MESSAGES_KEY = 'messages';
const PROFILES_KEY = 'profiles';
const FEEDBACK_KEY = 'feedback';
const DIRECT_KEY = 'direct-messages';
const CHAT_GENERAL_KEY = 'chat-general';
const CHAT_DIRECT_KEY = 'chat-direct';
const PRESENCE_KEY = 'presence';
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'degistir-bu-sifreyi').trim();

const loginAttempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function checkPassword(input, req) {
  const ip = getIp(req);
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (entry && now - entry.first > WINDOW_MS) entry = null;

  if (entry && entry.count >= MAX_ATTEMPTS) return 'locked';

  const clean = (input || '').trim();
  const ok = clean === ADMIN_PASSWORD;

  if (!ok) {
    if (!entry) entry = { count: 0, first: now };
    entry.count++;
    loginAttempts.set(ip, entry);
  } else {
    loginAttempts.delete(ip);
  }
  return ok;
}

function passwordCheckResponse(res, result) {
  if (result === 'locked') {
    res.status(429).json({ ok: false, error: 'Çok fazla yanlış deneme yapıldı. 10 dakika sonra tekrar dene.' });
    return true;
  }
  if (!result) {
    res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
    return true;
  }
  return false;
}

app.post('/api/admin-check', (req, res) => {
  const result = checkPassword(req.body.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ ok: true });
});

let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = keys.publicKey;
  VAPID_PRIVATE_KEY = keys.privateKey;
  console.log('\n=== VAPID ANAHTARLARI OTOMATİK ÜRETİLDİ ===');
  console.log('VAPID_PUBLIC_KEY=' + VAPID_PUBLIC_KEY);
  console.log('VAPID_PRIVATE_KEY=' + VAPID_PRIVATE_KEY);
  console.log('===========================================\n');
}

webpush.setVapidDetails('mailto:ofis@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

app.get('/api/messages', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(1, Math.min(200, parseInt(req.query.pageSize, 10) || 10));
  const all = (await loadJson(MESSAGES_KEY)).slice().reverse();
  const total = all.length;
  const start = (page - 1) * pageSize;
  const messages = all.slice(start, start + pageSize);
  res.json({ messages, total, page, pageSize });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
  const { deviceId, ...subscription } = req.body;
  const subs = await loadJson(SUBS_KEY);
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push({ ...subscription, deviceId: deviceId || null, name: null, subscribedAt: new Date().toISOString() });
    await saveJson(SUBS_KEY, subs);
  } else if (deviceId && !exists.deviceId) {
    exists.deviceId = deviceId;
    await saveJson(SUBS_KEY, subs);
  }
  res.status(201).json({ ok: true, total: subs.length });
});

app.get('/api/devices', async (req, res) => {
  const subs = await loadJson(SUBS_KEY);
  const profiles = await loadJson(PROFILES_KEY, {});
  const byDevice = new Map();
  for (const s of subs) {
    if (!s.deviceId) continue;
    const profile = profiles[s.deviceId];
    byDevice.set(s.deviceId, {
      deviceId: s.deviceId,
      name: s.name || null,
      subscribedAt: s.subscribedAt || null,
      suggestedName: profile ? profile.name : null,
      suggestedPhone: profile ? profile.phone : null,
      email: profile ? profile.email : null,
      bloodType: profile ? profile.bloodType : null,
      avatar: profile ? profile.avatar : null,
    });
  }
  res.json({ devices: Array.from(byDevice.values()).sort((a, b) => (b.subscribedAt || '').localeCompare(a.subscribedAt || '')) });
});

app.post('/api/self-profile', async (req, res) => {
  const { deviceId, name, phone, email, bloodType } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const profiles = await loadJson(PROFILES_KEY, {});
  const existing = profiles[deviceId] || {};
  profiles[deviceId] = {
    ...existing,
    name: (name || '').trim() || null,
    phone: (phone || '').trim() || null,
    email: (email !== undefined ? (email || '').trim() || null : existing.email || null),
    bloodType: (bloodType !== undefined ? (bloodType || '').trim() || null : existing.bloodType || null),
    updatedAt: new Date().toISOString(),
  };
  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true });
});

app.post('/api/self-profile/avatar', avatarUpload.single('avatar'), async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel yüklenemedi.' });
  const profiles = await loadJson(PROFILES_KEY, {});
  const existing = profiles[deviceId] || {};
  profiles[deviceId] = { ...existing, avatar: '/uploads/' + req.file.filename, updatedAt: new Date().toISOString() };
  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true, avatar: profiles[deviceId].avatar });
});

app.get('/api/self-profile/:deviceId', async (req, res) => {
  const profiles = await loadJson(PROFILES_KEY, {});
  res.json({ profile: profiles[req.params.deviceId] || null });
});

app.post('/api/feedback', async (req, res) => {
  const text = (req.body.text || '').trim();
  const name = (req.body.name || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Boş gönderilemez.' });
  const list = await loadJson(FEEDBACK_KEY);
  list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, name: name || null, time: new Date().toISOString() });
  await saveJson(FEEDBACK_KEY, list.slice(-200));
  res.json({ ok: true });
});

app.get('/api/feedback', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ items: (await loadJson(FEEDBACK_KEY)).slice().reverse() });
});

app.post('/api/devices/name', async (req, res) => {
  const { password, deviceId, name } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const subs = await loadJson(SUBS_KEY);
  for (const s of subs) { if (s.deviceId === deviceId) s.name = (name || '').trim() || null; }
  await saveJson(SUBS_KEY, subs);
  res.json({ ok: true });
});

app.post('/api/send', upload.single('attachment'), async (req, res) => {
  const { password, category, title, body } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  const attachment = attachmentFromFile(req.file);
  const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const subs = await loadJson(SUBS_KEY);

  const payload = JSON.stringify({
    id: messageId,
    title: title,
    body,
    category: category || 'genel',
    urgent: true,
    image: (attachment && attachment.type === 'image')
      ? attachment.url
      : `/api/notif-image?title=${encodeURIComponent(title)}&category=${encodeURIComponent(category || 'genel')}`,
  });

  let sent = 0;
  const stillValid = [];

  const requestOptions = {
    headers: {
      'Urgency': 'high',
      'Topic': category || 'genel'
    },
    TTL: 86400
  };

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, requestOptions);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      if (err.statusCode !== 410 && err.statusCode !== 404) stillValid.push(sub);
    }
  }

  await saveJson(SUBS_KEY, stillValid);

  const messages = await loadJson(MESSAGES_KEY);
  messages.push({ id: messageId, category: category || 'genel', title, body, time: new Date().toISOString(), attachment, reads: [] });
  await saveJson(MESSAGES_KEY, messages.slice(-100));

  res.json({ ok: true, sent, totalSubscribers: stillValid.length, messageId });
});

// --- KİŞİYE ÖZEL (HEDEFLİ) BİLDİRİM GÖNDERME ---
app.post('/api/send-to', upload.single('attachment'), async (req, res) => {
  const { password, deviceId, title, body, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Kişi seçilmedi.' });
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  const subs = await loadJson(SUBS_KEY);
  const targetSubs = subs.filter(s => s.deviceId === deviceId);
  if (targetSubs.length === 0) return res.status(404).json({ ok: false, error: 'Bu kişiye ait aktif bildirim aboneliği bulunamadı.' });

  const attachment = attachmentFromFile(req.file);
  const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const payload = JSON.stringify({
    id: messageId,
    title: title,
    body,
    category: category || 'genel',
    urgent: true,
    personal: true,
    image: (attachment && attachment.type === 'image')
      ? attachment.url
      : `/api/notif-image?title=${encodeURIComponent(title)}&category=${encodeURIComponent(category || 'genel')}`,
  });

  const requestOptions = { headers: { Urgency: 'high', Topic: 'kisiye-ozel' }, TTL: 86400 };

  let sent = 0;
  for (const sub of targetSubs) {
    try {
      await webpush.sendNotification(sub, payload, requestOptions);
      sent++;
    } catch (err) {
      // sessizce yut, hedefli mesajlarda ana abonelik listesini bozmayalım
    }
  }

  const direct = await loadJson(DIRECT_KEY);
  direct.push({ id: messageId, deviceId, category: category || 'genel', title, body, time: new Date().toISOString(), attachment });
  await saveJson(DIRECT_KEY, direct.slice(-500));

  res.json({ ok: true, sent });
});

app.delete('/api/messages/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const messages = (await loadJson(MESSAGES_KEY)).filter(m => m.id !== req.params.id);
  await saveJson(MESSAGES_KEY, messages);
  res.json({ ok: true });
});

app.post('/api/messages/:id/read', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false });
  const messages = await loadJson(MESSAGES_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  if (!msg.reads) msg.reads = [];
  if (!msg.reads.some(r => r.deviceId === deviceId)) {
    msg.reads.push({ deviceId, time: new Date().toISOString() });
    await saveJson(MESSAGES_KEY, messages);
  }
  res.json({ ok: true });
});

app.get('/api/messages/:id/reads', async (req, res) => {
  const messages = await loadJson(MESSAGES_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  const subs = await loadJson(SUBS_KEY);
  const profiles = await loadJson(PROFILES_KEY, {});
  const reads = (msg.reads || []).map(r => {
    const sub = subs.find(s => s.deviceId === r.deviceId);
    const profile = profiles[r.deviceId];
    let label = sub && sub.name ? sub.name : (profile && profile.name ? profile.name + ' (kendi beyanı)' : 'Cihaz #' + (r.deviceId || '').slice(-4));
    return { name: label, time: r.time };
  });
  res.json({ reads, totalSubscribers: subs.length });
});

// --- GÜNLÜK İSTATİSTİKLER (ADMIN DASHBOARD) ---
app.get('/api/stats', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;

  const subs = await loadJson(SUBS_KEY);
  const profiles = await loadJson(PROFILES_KEY, {});
  const messages = await loadJson(MESSAGES_KEY);
  const feedback = await loadJson(FEEDBACK_KEY);

  const totalSubscribers = subs.length;
  const namedDevices = Object.values(profiles).filter(p => p.name).length;

  const last30 = messages.slice(-30);
  const perMessage = last30.map(m => ({
    id: m.id,
    title: m.title,
    category: m.category,
    time: m.time,
    readCount: (m.reads || []).length,
  })).reverse();

  const today = new Date().toISOString().slice(0, 10);
  const todaysMessages = messages.filter(m => (m.time || '').slice(0, 10) === today).length;
  const todaysFeedback = feedback.filter(f => (f.time || '').slice(0, 10) === today).length;

  res.json({
    totalSubscribers,
    namedDevices,
    totalMessages: messages.length,
    todaysMessages,
    totalFeedback: feedback.length,
    todaysFeedback,
    perMessage,
  });
});

// --- KİMLİK DOĞRULAMA YARDIMCI FONKSİYONU (SOHBET İÇİN) ---
async function requireCompleteProfile(deviceId) {
  if (!deviceId) return { ok: false, error: 'Cihaz kimliği eksik.' };
  const profiles = await loadJson(PROFILES_KEY, {});
  const p = profiles[deviceId];
  if (!p || !p.name || !p.phone) {
    return { ok: false, error: 'Sohbete katılmak için önce Profilim bölümünden adınızı ve telefon numaranızı girmelisiniz.' };
  }
  return { ok: true, profile: p };
}

// --- ÇEVRİMİÇİ DURUM (PRESENCE) ---
app.post('/api/presence', async (req, res) => {
  const { deviceId } = req.body;
  const check = await requireCompleteProfile(deviceId);
  if (!check.ok) return res.status(403).json({ ok: false, error: check.error });
  const presence = await loadJson(PRESENCE_KEY, {});
  presence[deviceId] = Date.now();
  await saveJson(PRESENCE_KEY, presence);
  res.json({ ok: true });
});

app.get('/api/presence', async (req, res) => {
  const presence = await loadJson(PRESENCE_KEY, {});
  const now = Date.now();
  const online = Object.entries(presence)
    .filter(([, ts]) => now - ts < 90 * 1000)
    .map(([deviceId]) => deviceId);
  res.json({ online });
});

// --- SOHBET İÇİN KİŞİ LİSTESİ (profilini tamamlamış herkes) ---
app.get('/api/chat/contacts', async (req, res) => {
  const { deviceId } = req.query;
  const profiles = await loadJson(PROFILES_KEY, {});
  const presence = await loadJson(PRESENCE_KEY, {});
  const now = Date.now();
  const contacts = Object.entries(profiles)
    .filter(([id, p]) => id !== deviceId && p.name && p.phone)
    .map(([id, p]) => ({
      deviceId: id,
      name: p.name,
      avatar: p.avatar || null,
      online: presence[id] ? (now - presence[id] < 90 * 1000) : false,
    }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'tr'));
  res.json({ contacts });
});

// --- GENEL SOHBET ODASI ---
app.get('/api/chat/general', async (req, res) => {
  const messages = (await loadJson(CHAT_GENERAL_KEY)).slice(-100);
  res.json({ messages });
});

app.post('/api/chat/general', async (req, res) => {
  const { deviceId, text } = req.body;
  const check = await requireCompleteProfile(deviceId);
  if (!check.ok) return res.status(403).json({ ok: false, error: check.error });
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });

  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    deviceId,
    name: check.profile.name,
    avatar: check.profile.avatar || null,
    text: clean,
    time: new Date().toISOString(),
  };
  messages.push(msg);
  await saveJson(CHAT_GENERAL_KEY, messages.slice(-500));
  res.json({ ok: true, message: msg });
});

// --- BİREBİR ÖZEL SOHBET ---
function conversationKey(a, b) { return [a, b].sort().join('__'); }

app.get('/api/chat/direct', async (req, res) => {
  const { deviceId, withId } = req.query;
  if (!deviceId || !withId) return res.status(400).json({ ok: false, error: 'Eksik parametre.' });
  const all = await loadJson(CHAT_DIRECT_KEY);
  const key = conversationKey(deviceId, withId);
  const messages = all.filter(m => m.key === key).slice(-200);
  res.json({ messages });
});

app.post('/api/chat/direct', async (req, res) => {
  const { deviceId, toDeviceId, text } = req.body;
  const check = await requireCompleteProfile(deviceId);
  if (!check.ok) return res.status(403).json({ ok: false, error: check.error });
  const toCheck = await requireCompleteProfile(toDeviceId);
  if (!toCheck.ok) return res.status(403).json({ ok: false, error: 'Karşı taraf henüz profilini tamamlamamış.' });
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });

  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key: conversationKey(deviceId, toDeviceId),
    fromDeviceId: deviceId,
    toDeviceId,
    fromName: check.profile.name,
    text: clean,
    time: new Date().toISOString(),
  };
  all.push(msg);
  await saveJson(CHAT_DIRECT_KEY, all.slice(-2000));

  // Karşı tarafa push bildirimi de gönder (aktif abonelikleri varsa)
  const subs = (await loadJson(SUBS_KEY)).filter(s => s.deviceId === toDeviceId);
  if (subs.length) {
    const payload = JSON.stringify({
      id: msg.id,
      title: `💬 ${check.profile.name}`,
      body: clean,
      category: 'genel',
      urgent: false,
      personal: true,
    });
    subs.forEach(sub => { webpush.sendNotification(sub, payload, { TTL: 86400 }).catch(() => {}); });
  }

  res.json({ ok: true, message: msg });
});

// --- SOHBET DENETİMİ (YÖNETİCİ) ---
app.get('/api/chat/general/all', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ messages: (await loadJson(CHAT_GENERAL_KEY)).slice(-300).reverse() });
});

app.delete('/api/chat/general/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const messages = (await loadJson(CHAT_GENERAL_KEY)).filter(m => m.id !== req.params.id);
  await saveJson(CHAT_GENERAL_KEY, messages);
  res.json({ ok: true });
});

app.get('/api/chat/direct/all', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  const profiles = await loadJson(PROFILES_KEY, {});
  const all = (await loadJson(CHAT_DIRECT_KEY)).slice(-300).reverse().map(m => ({
    ...m,
    fromLabel: (profiles[m.fromDeviceId] && profiles[m.fromDeviceId].name) || m.fromName || 'Bilinmeyen',
    toLabel: (profiles[m.toDeviceId] && profiles[m.toDeviceId].name) || 'Bilinmeyen',
  }));
  res.json({ messages: all });
});

app.delete('/api/chat/direct/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const messages = (await loadJson(CHAT_DIRECT_KEY)).filter(m => m.id !== req.params.id);
  await saveJson(CHAT_DIRECT_KEY, messages);
  res.json({ ok: true });
});

function categoryEmoji(cat) {
  switch (cat) {
    case 'acil': return '🚨';
    case 'yemek': return '🍽️';
    case 'vefat': return '🕯️';
    case 'dogum': return '🎉';
    default: return '📢';
  }
}

// --- BİLDİRİM İÇİN DİNAMİK BAŞLIK GÖRSELİ (arka plan + büyük harf başlık) ---
function categoryColors(cat) {
  const map = {
    acil: ['#E0972C', '#B5674A'],
    yemek: ['#6B8F71', '#3E5C43'],
    vefat: ['#4A4A52', '#1F2430'],
    dogum: ['#C9A24B', '#8A6D2F'],
    genel: ['#7A2331', '#5A1622'],
  };
  return map[cat] || map.genel;
}

function escXml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Türkçe büyük harfe çevirme: standart toUpperCase() 'i'/'ı' ayrımını bilmiyor (İ yerine I yapıyor).
function turkishUpper(str) {
  return (str || '')
    .replace(/i/g, 'İ')
    .replace(/ı/g, 'I')
    .toUpperCase();
}

async function generateNotifImage(title, category) {
  const [c1, c2] = categoryColors(category);
  const upper = turkishUpper(title || 'DUYURU');
  const words = upper.split(' ');
  let lines = [];
  let cur = '';
  words.forEach(w => {
    if ((cur + ' ' + w).trim().length > 22) { lines.push(cur.trim()); cur = w; }
    else { cur = (cur + ' ' + w).trim(); }
  });
  if (cur) lines.push(cur);
  lines = lines.slice(0, 3);

  const width = 1200, height = 400;
  const lineHeight = 62;
  const startY = height / 2 - (lines.length - 1) * lineHeight / 2 + 20;
  const textSvg = lines.map((line, i) =>
    `<text x="60" y="${startY + i * lineHeight}" font-family="Arial, Liberation Sans, DejaVu Sans, sans-serif" font-size="56" font-weight="900" fill="#ffffff" letter-spacing="1">${escXml(line)}</text>`
  ).join('');

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${c1}"/>
        <stop offset="100%" stop-color="${c2}"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#bg)"/>
    ${textSvg}
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

app.get('/api/notif-image', async (req, res) => {
  try {
    const title = (req.query.title || 'Duyuru').slice(0, 120);
    const category = req.query.category || 'genel';
    const buf = await generateNotifImage(title, category);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) {
    res.status(500).end();
  }
});

app.get('/api/subscriber-count', async (req, res) => {
  res.json({ total: (await loadJson(SUBS_KEY)).length });
});

// --- SUNUCU SAĞLIK / DEPOLAMA DURUMU (tanı amaçlı) ---
app.get('/api/storage-status', (req, res) => {
  res.json({
    persistent: !!redis,
    mode: redis ? 'upstash-redis (kalıcı)' : 'yerel dosya (KALICI DEĞİL — her deploy/uykuda sıfırlanır)',
  });
});

function makeListApi(name, key) {
  app.get(`/api/${name}`, async (req, res) => {
    res.json({ items: (await loadJson(key)).slice().reverse() });
  });

  app.post(`/api/${name}`, upload.single('attachment'), async (req, res) => {
    const { password, ...fields } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    const attachment = attachmentFromFile(req.file);
    const items = await loadJson(key);
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), done: false, attachment, ...fields };
    items.push(item);
    await saveJson(key, items.slice(-200));
    res.json({ ok: true, item });
  });

  app.delete(`/api/${name}/:id`, async (req, res) => {
    const { password } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    const items = (await loadJson(key)).filter(i => i.id !== req.params.id);
    await saveJson(key, items);
    res.json({ ok: true });
  });

  app.post(`/api/${name}/:id/toggle`, async (req, res) => {
    const items = await loadJson(key);
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false });
    item.done = !item.done;
    await saveJson(key, items);
    res.json({ ok: true, done: item.done });
  });
}

makeListApi('notes', 'notes');
makeListApi('phones', 'phones');
makeListApi('tasks', 'tasks');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ofis Duyuru Sistemi aktif: http://localhost:${PORT}`));
