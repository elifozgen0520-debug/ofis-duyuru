const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dosya yükleme (JPG/PNG/PDF)
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
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB Sınır
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Sadece JPG, PNG veya PDF yükleyebilirsiniz.'), ok);
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

const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'degistir-bu-sifreyi').trim();

// Brute-force koruması
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

// VAPID Anahtarları
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

function loadJson(file, def = []) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }
function saveJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

app.get('/api/messages', (req, res) => {
  res.json({ messages: loadJson(MESSAGES_FILE).slice(-30).reverse() });
});

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  const { deviceId, ...subscription } = req.body;
  const subs = loadJson(SUBS_FILE);
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push({ ...subscription, deviceId: deviceId || null, name: null, subscribedAt: new Date().toISOString() });
    saveJson(SUBS_FILE, subs);
  } else if (deviceId && !exists.deviceId) {
    exists.deviceId = deviceId;
    saveJson(SUBS_FILE, subs);
  }
  res.status(201).json({ ok: true, total: subs.length });
});

app.get('/api/devices', (req, res) => {
  const subs = loadJson(SUBS_FILE);
  const profiles = loadJson(PROFILES_FILE, {});
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
    });
  }
  res.json({ devices: Array.from(byDevice.values()).sort((a, b) => (b.subscribedAt || '').localeCompare(a.subscribedAt || '')) });
});

app.post('/api/self-profile', (req, res) => {
  const { deviceId, name, phone } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const profiles = loadJson(PROFILES_FILE, {});
  profiles[deviceId] = { name: (name || '').trim() || null, phone: (phone || '').trim() || null, updatedAt: new Date().toISOString() };
  saveJson(PROFILES_FILE, profiles);
  res.json({ ok: true });
});

app.post('/api/feedback', (req, res) => {
  const text = (req.body.text || '').trim();
  const name = (req.body.name || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Boş gönderilemez.' });
  const list = loadJson(FEEDBACK_FILE);
  list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, name: name || null, time: new Date().toISOString() });
  saveJson(FEEDBACK_FILE, list.slice(-200));
  res.json({ ok: true });
});

app.get('/api/feedback', (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ items: loadJson(FEEDBACK_FILE).slice().reverse() });
});

app.post('/api/devices/name', (req, res) => {
  const { password, deviceId, name } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const subs = loadJson(SUBS_FILE);
  for (const s of subs) { if (s.deviceId === deviceId) s.name = (name || '').trim() || null; }
  saveJson(SUBS_FILE, subs);
  res.json({ ok: true });
});

// Yüksek Öncelikli Push Bildirimi (Urgency: high)
app.post('/api/send', upload.single('attachment'), async (req, res) => {
  const { password, category, title, body } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  const attachment = attachmentFromFile(req.file);
  const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const subs = loadJson(SUBS_FILE);

  const payload = JSON.stringify({
    id: messageId,
    title: `${categoryEmoji(category)} ${title}`,
    body,
    category: category || 'genel',
    urgent: true,
    image: attachment && attachment.type === 'image' ? attachment.url : undefined,
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

  saveJson(SUBS_FILE, stillValid);

  const messages = loadJson(MESSAGES_FILE);
  messages.push({ id: messageId, category: category || 'genel', title, body, time: new Date().toISOString(), attachment, reads: [] });
  saveJson(MESSAGES_FILE, messages.slice(-100));

  res.json({ ok: true, sent, totalSubscribers: stillValid.length, messageId });
});

app.delete('/api/messages/:id', (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const messages = loadJson(MESSAGES_FILE).filter(m => m.id !== req.params.id);
  saveJson(MESSAGES_FILE, messages);
  res.json({ ok: true });
});

app.post('/api/messages/:id/read', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false });
  const messages = loadJson(MESSAGES_FILE);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  if (!msg.reads) msg.reads = [];
  if (!msg.reads.some(r => r.deviceId === deviceId)) {
    msg.reads.push({ deviceId, time: new Date().toISOString() });
    saveJson(MESSAGES_FILE, messages);
  }
  res.json({ ok: true });
});

app.get('/api/messages/:id/reads', (req, res) => {
  const messages = loadJson(MESSAGES_FILE);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  const subs = loadJson(SUBS_FILE);
  const profiles = loadJson(PROFILES_FILE, {});
  const reads = (msg.reads || []).map(r => {
    const sub = subs.find(s => s.deviceId === r.deviceId);
    const profile = profiles[r.deviceId];
    let label = sub && sub.name ? sub.name : (profile && profile.name ? profile.name + ' (kendi beyanı)' : 'Cihaz #' + (r.deviceId || '').slice(-4));
    return { name: label, time: r.time };
  });
  res.json({ reads, totalSubscribers: subs.length });
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

app.get('/api/subscriber-count', (req, res) => {
  res.json({ total: loadJson(SUBS_FILE).length });
});

function makeListApi(name, fileName) {
  const FILE = path.join(__dirname, fileName);

  app.get(`/api/${name}`, (req, res) => {
    res.json({ items: loadJson(FILE).slice().reverse() });
  });

  app.post(`/api/${name}`, upload.single('attachment'), (req, res) => {
    const { password, ...fields } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    const attachment = attachmentFromFile(req.file);
    const items = loadJson(FILE);
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), done: false, attachment, ...fields };
    items.push(item);
    saveJson(FILE, items.slice(-200));
    res.json({ ok: true, item });
  });

  app.delete(`/api/${name}/:id`, (req, res) => {
    const { password } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    const items = loadJson(FILE).filter(i => i.id !== req.params.id);
    saveJson(FILE, items);
    res.json({ ok: true });
  });

  app.post(`/api/${name}/:id/toggle`, (req, res) => {
    const items = loadJson(FILE);
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false });
    item.done = !item.done;
    saveJson(FILE, items);
    res.json({ ok: true, done: item.done });
  });
}

makeListApi('notes', 'notes.json');
makeListApi('phones', 'phones.json');
makeListApi('tasks', 'tasks.json');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ofis Duyuru Sistemi aktif: http://localhost:${PORT}`));