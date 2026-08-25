const express = require('express');
const webpush = require('web-push');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype);
    cb(ok ? null : new Error('Sadece JPG, PNG veya PDF yükleyebilirsiniz.'), ok);
  },
});

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Sadece JPG, PNG veya WEBP yükleyebilirsiniz.'), ok);
  },
});

function makeFilename(originalname, prefix) {
  const ext = path.extname(originalname || '').toLowerCase();
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
}

async function compressIfImage(file) {
  const isImage = file.mimetype === 'image/jpeg' || file.mimetype === 'image/png' || file.mimetype === 'image/webp';
  if (!isImage) return file;
  try {
    const compressed = await sharp(file.buffer)
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toBuffer();
    return { ...file, buffer: compressed, mimetype: 'image/jpeg' };
  } catch (err) {
    console.error('Resim sıkıştırılamadı, orijinal kullanılıyor:', err.message);
    return file;
  }
}

async function saveFileToStore(file, prefix) {
  if (!file) return null;
  file = await compressIfImage(file);
  const filename = makeFilename(file.originalname, prefix);

  const approxBase64Size = Math.ceil(file.buffer.length * 4 / 3);
  if (redis && approxBase64Size > 9 * 1024 * 1024) {
    throw new Error('Dosya çok büyük (sıkıştırma sonrası bile). Lütfen daha küçük bir dosya deneyin.');
  }

  if (redis) {
    await redis.set('file:' + filename, JSON.stringify({
      mimetype: file.mimetype,
      data: file.buffer.toString('base64'),
      originalname: file.originalname,
    }));
  } else {
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), file.buffer);
  }
  return filename;
}

async function attachmentFromFile(file) {
  if (!file) return null;
  const filename = await saveFileToStore(file);
  return {
    url: '/uploads/' + filename,
    type: file.mimetype === 'application/pdf' ? 'pdf' : 'image',
    name: file.originalname,
  };
}

app.get('/uploads/:filename', async (req, res) => {
  if (!redis) return res.status(404).end();
  try {
    const raw = await redis.get('file:' + req.params.filename);
    if (!raw) return res.status(404).end();
    const obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
    const buf = Buffer.from(obj.data, 'base64');
    res.set('Content-Type', obj.mimetype || 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buf);
  } catch (err) {
    res.status(500).end();
  }
});

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const redis = (UPSTASH_URL && UPSTASH_TOKEN) ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN }) : null;

if (!redis) {
  console.warn('\n⚠️ UYARI: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tanımlı değil.');
  console.warn('⚠️ Veriler KALICI OLMAYACAK — her deploy/uyku sonrası sıfırlanacak!\n');
}

async function loadJson(key, def) {
  const fallback = def !== undefined ? def : [];
  if (redis) {
    try {
      const val = await redis.get(key);
      if (val === null || val === undefined) return fallback;
      return (typeof val === 'string') ? JSON.parse(val) : val;
    } catch (err) {
      console.error('Redis okuma hatası (' + key + '):', err.message);
      return fallback;
    }
  }
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
const POLLS_KEY = 'polls';
const DIRECT_KEY = 'direct-messages';
const CHAT_GENERAL_KEY = 'chat-general';
const CHAT_DIRECT_KEY = 'chat-direct';
const PRESENCE_KEY = 'presence';
const COMMENTS_KEY = 'message-comments';
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

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'duyuru@salihozgen.com';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function categoryColorHex(cat) {
  const map = { acil: '#E0972C', yemek: '#6B8F71', vefat: '#4A4A52', dogum: '#C9A24B', genel: '#7A2331' };
  return map[cat] || map.genel;
}

async function sendAnnouncementEmails(title, body, category) {
  if (!resend) return { attempted: 0, sent: 0, skipped: 'RESEND_API_KEY tanımlı değil' };
  const profiles = await loadJson(PROFILES_KEY, {});
  const emails = Object.values(profiles).map(p => p.email).filter(Boolean);
  if (emails.length === 0) return { attempted: 0, sent: 0 };

  const color = categoryColorHex(category);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <div style="background:${color}; color:#fff; padding:20px 24px; border-radius:6px 6px 0 0;">
        <div style="font-size:11px; letter-spacing:1px; text-transform:uppercase; opacity:0.85; margin-bottom:6px;">${catNamesEmail(category)}</div>
        <h2 style="margin:0; font-size:20px;">${escapeHtml(title)}</h2>
      </div>
      <div style="background:#F7F5F0; padding:20px 24px; border-radius:0 0 6px 6px; color:#1F2430;">
        <p style="font-size:14px; line-height:1.6; margin:0;">${escapeHtml(body)}</p>
        <p style="font-size:11px; color:#888; margin-top:20px;">Bu e-posta, Amasya CSB Acil Duyuru Sistemi tarafından otomatik gönderilmiştir.</p>
      </div>
    </div>`;

  let sent = 0;
  for (const email of emails) {
    try {
      await resend.emails.send({ from: RESEND_FROM, to: email, subject: `${catNamesEmail(category)}: ${title}`, html });
      sent++;
    } catch (err) {
      console.error('E-posta gönderilemedi (' + email + '):', err.message);
    }
  }
  return { attempted: emails.length, sent };
}

function catNamesEmail(cat) {
  const map = { acil: 'Acil Duyuru', yemek: 'Yemek Listesi', vefat: 'Vefat', dogum: 'Doğum', genel: 'Duyuru' };
  return map[cat] || map.genel;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  const { deviceId, name, phone, email, bloodType, bloodDonorOptIn, kvkkConsent, kvkkConsentAt } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const profiles = await loadJson(PROFILES_KEY, {});
  const existing = profiles[deviceId] || {};
  profiles[deviceId] = {
    ...existing,
    name: (name || '').trim() || null,
    phone: (phone || '').trim() || null,
    email: (email !== undefined ? (email || '').trim() || null : existing.email || null),
    bloodType: (bloodType !== undefined ? (bloodType || '').trim() || null : existing.bloodType || null),
    bloodDonorOptIn: (bloodDonorOptIn !== undefined ? !!bloodDonorOptIn : existing.bloodDonorOptIn || false),
    kvkkConsent: (kvkkConsent !== undefined ? !!kvkkConsent : existing.kvkkConsent || false),
    kvkkConsentAt: (kvkkConsentAt !== undefined ? kvkkConsentAt : existing.kvkkConsentAt || null),
    updatedAt: new Date().toISOString(),
  };
  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true });
});

// --- KAN BANKASI API (GÜNCELLENDİ) ---
app.get('/api/blood-bank', async (req, res) => {
  const type = (req.query.type || '').trim();
  const profiles = await loadJson(PROFILES_KEY, {});
  const results = Object.values(profiles)
    .filter(p => p.bloodDonorOptIn && p.bloodType && p.name && p.phone)
    .filter(p => !type || p.bloodType === type)
    .map(p => ({ name: p.name, phone: p.phone, bloodType: p.bloodType }));
  res.json({ results });
});

app.post('/api/self-profile/avatar', avatarUpload.single('avatar'), async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel yüklenemedi.' });
  try {
    const filename = await saveFileToStore(req.file, 'avatar-');
    const profiles = await loadJson(PROFILES_KEY, {});
    const existing = profiles[deviceId] || {};
    profiles[deviceId] = { ...existing, avatar: '/uploads/' + filename, updatedAt: new Date().toISOString() };
    await saveJson(PROFILES_KEY, profiles);
    res.json({ ok: true, avatar: profiles[deviceId].avatar });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Fotoğraf kaydedilemedi.' });
  }
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
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, name: name || null, time: new Date().toISOString() };
  list.push(item);
  await saveJson(FEEDBACK_KEY, list.slice(-200));
  res.json({ ok: true });

  if (resend) {
    resend.emails.send({
      from: RESEND_FROM,
      to: 'salihozgen35@gmail.com',
      subject: `📩 Yeni İletişim Formu Mesajı${name ? ' — ' + name : ''}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A2331;">Yeni bir mesaj geldi</h2>
        <p><b>Gönderen:</b> ${name ? escapeHtml(name) : 'İsimsiz'}</p>
        <p><b>Zaman:</b> ${new Date(item.time).toLocaleString('tr-TR')}</p>
        <div style="background:#f7f5f0; border-radius:8px; padding:14px 16px; margin-top:10px; white-space:pre-wrap; color:#1F2430;">${escapeHtml(text)}</div>
      </div>`,
    }).catch(err => console.error('İletişim formu e-postası gönderilemedi:', err.message));
  }
});

app.get('/api/feedback', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ items: (await loadJson(FEEDBACK_KEY)).slice().reverse() });
});

// --- ANKET (POLL) ---
app.post('/api/polls', async (req, res) => {
  const { password, question, options } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const q = (question || '').trim();
  const opts = Array.isArray(options) ? options.map(o => (o || '').trim()).filter(Boolean) : [];
  if (!q) return res.status(400).json({ ok: false, error: 'Soru gerekli.' });
  if (opts.length < 2) return res.status(400).json({ ok: false, error: 'En az 2 seçenek gerekli.' });

  const polls = await loadJson(POLLS_KEY);
  const poll = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    question: q,
    options: opts.map(text => ({ text, votes: 0 })),
    voters: {},
    active: true,
    createdAt: new Date().toISOString(),
  };
  polls.push(poll);
  await saveJson(POLLS_KEY, polls);
  res.json({ ok: true, poll });
});

app.get('/api/polls', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ polls: (await loadJson(POLLS_KEY)).slice().reverse() });
});

app.get('/api/polls/active', async (req, res) => {
  const { deviceId } = req.query;
  const polls = await loadJson(POLLS_KEY);
  const active = polls.filter(p => p.active).slice().reverse();
  const out = active.map(p => {
    const total = p.options.reduce((s, o) => s + o.votes, 0);
    const myVote = deviceId && p.voters && p.voters[deviceId] !== undefined ? p.voters[deviceId] : null;
    return {
      id: p.id,
      question: p.question,
      options: p.options.map(o => ({ text: o.text, votes: o.votes })),
      createdAt: p.createdAt,
      totalVotes: total,
      myVote,
    };
  });
  res.json({ polls: out });
});

app.post('/api/polls/:id/vote', async (req, res) => {
  const { deviceId, optionIndex } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği gerekli.' });
  const idx = parseInt(optionIndex, 10);

  const polls = await loadJson(POLLS_KEY);
  const poll = polls.find(p => p.id === req.params.id);
  if (!poll) return res.status(404).json({ ok: false, error: 'Anket bulunamadı.' });
  if (!poll.active) return res.status(400).json({ ok: false, error: 'Bu anket kapatılmış.' });
  if (isNaN(idx) || idx < 0 || idx >= poll.options.length) return res.status(400).json({ ok: false, error: 'Geçersiz seçenek.' });
  if (!poll.voters) poll.voters = {};
  if (poll.voters[deviceId] !== undefined) return res.status(400).json({ ok: false, error: 'Zaten oy kullanılmış.' });

  poll.voters[deviceId] = idx;
  poll.options[idx].votes = (poll.options[idx].votes || 0) + 1;
  await saveJson(POLLS_KEY, polls);

  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  res.json({
    ok: true,
    poll: { id: poll.id, question: poll.question, options: poll.options.map(o => ({ text: o.text, votes: o.votes })), myVote: idx, totalVotes: total },
  });
});

app.put('/api/polls/:id', async (req, res) => {
  const { password, active } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const polls = await loadJson(POLLS_KEY);
  const poll = polls.find(p => p.id === req.params.id);
  if (!poll) return res.status(404).json({ ok: false, error: 'Anket bulunamadı.' });
  if (active !== undefined) poll.active = !!active;
  await saveJson(POLLS_KEY, polls);
  res.json({ ok: true });
});

app.delete('/api/polls/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const polls = (await loadJson(POLLS_KEY)).filter(p => p.id !== req.params.id);
  await saveJson(POLLS_KEY, polls);
  res.json({ ok: true });
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

app.delete('/api/devices/:deviceId', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const { deviceId } = req.params;

  const subs = (await loadJson(SUBS_KEY)).filter(s => s.deviceId !== deviceId);
  await saveJson(SUBS_KEY, subs);

  const profiles = await loadJson(PROFILES_KEY, {});
  delete profiles[deviceId];
  await saveJson(PROFILES_KEY, profiles);

  res.json({ ok: true });
});

app.post('/api/send', upload.single('attachment'), async (req, res) => {
  const { password, category, title, body, alsoEmail } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  let attachment;
  try {
    attachment = await attachmentFromFile(req.file);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Dosya yüklenemedi.' });
  }
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
  const requestOptions = { headers: { 'Urgency': 'high', 'Topic': category || 'genel' }, TTL: 86400 };

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

  let emailResult = null;
  if (alsoEmail === 'true' || alsoEmail === true) {
    emailResult = await sendAnnouncementEmails(title, body, category || 'genel');
  }

  res.json({ ok: true, sent, totalSubscribers: stillValid.length, messageId, email: emailResult });
});

app.post('/api/send-to', upload.single('attachment'), async (req, res) => {
  const { password, deviceId, title, body, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Kişi seçilmedi.' });
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  const subs = await loadJson(SUBS_KEY);
  const targetSubs = subs.filter(s => s.deviceId === deviceId);
  if (targetSubs.length === 0) return res.status(404).json({ ok: false, error: 'Bu kişiye ait aktif bildirim bulunamadı.' });

  let attachment;
  try {
    attachment = await attachmentFromFile(req.file);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Dosya yüklenemedi.' });
  }
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
    } catch (err) {}
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

app.put('/api/messages/:id', async (req, res) => {
  const { password, title, body, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  const messages = await loadJson(MESSAGES_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Duyuru bulunamadı.' });

  msg.title = title;
  msg.body = body;
  if (category) msg.category = category;
  msg.editedAt = new Date().toISOString();

  await saveJson(MESSAGES_KEY, messages);
  res.json({ ok: true, message: msg });
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

async function requireCompleteProfile(deviceId) {
  if (!deviceId) return { ok: false, error: 'Cihaz kimliği eksik.' };
  const profiles = await loadJson(PROFILES_KEY, {});
  const p = profiles[deviceId];
  if (!p || !p.name || !p.phone) {
    return { ok: false, error: 'Sohbete katılmak için önce Profilim bölümünden adınızı ve telefonunuzu girmelisiniz.' };
  }
  return { ok: true, profile: p };
}

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
      lastSeen: presence[id] || null,
    }))
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'tr'));
  res.json({ contacts });
});

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
  if (!toCheck.ok) return res.status(403).json({ ok: false, error: 'Karşı taraf profili eksik.' });
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

app.put('/api/chat/general/:id', async (req, res) => {
  const { deviceId, text } = req.body;
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });
  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  if (!deviceId || msg.deviceId !== deviceId) return res.status(403).json({ ok: false, error: 'İzin yok.' });
  msg.text = clean;
  msg.editedAt = new Date().toISOString();
  await saveJson(CHAT_GENERAL_KEY, messages);
  res.json({ ok: true, message: msg });
});

app.post('/api/chat/general/read-bulk', async (req, res) => {
  const { deviceId, ids } = req.body;
  if (!deviceId || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false });
  const messages = await loadJson(CHAT_GENERAL_KEY);
  let changed = false;
  messages.forEach(m => {
    if (ids.includes(m.id) && m.deviceId !== deviceId) {
      if (!m.reads) m.reads = [];
      if (!m.reads.includes(deviceId)) { m.reads.push(deviceId); changed = true; }
    }
  });
  if (changed) await saveJson(CHAT_GENERAL_KEY, messages);
  res.json({ ok: true });
});

app.delete('/api/chat/general/:id', async (req, res) => {
  const { password, deviceId } = req.body;
  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  const isOwner = deviceId && msg.deviceId === deviceId;
  if (!isOwner) {
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
  }
  const filtered = messages.filter(m => m.id !== req.params.id);
  await saveJson(CHAT_GENERAL_KEY, filtered);
  res.json({ ok: true });
});

app.put('/api/chat/direct/:id', async (req, res) => {
  const { deviceId, text } = req.body;
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });
  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = all.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  if (!deviceId || msg.fromDeviceId !== deviceId) return res.status(403).json({ ok: false, error: 'İzin yok.' });
  msg.text = clean;
  msg.editedAt = new Date().toISOString();
  await saveJson(CHAT_DIRECT_KEY, all);
  res.json({ ok: true, message: msg });
});

app.post('/api/chat/direct/read-bulk', async (req, res) => {
  const { deviceId, ids } = req.body;
  if (!deviceId || !Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false });
  const all = await loadJson(CHAT_DIRECT_KEY);
  let changed = false;
  all.forEach(m => {
    if (ids.includes(m.id) && m.toDeviceId === deviceId && !m.read) {
      m.read = true;
      m.readAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) await saveJson(CHAT_DIRECT_KEY, all);
  res.json({ ok: true });
});

app.delete('/api/chat/direct/:id', async (req, res) => {
  const { password, deviceId } = req.body;
  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = all.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  const isOwner = deviceId && msg.fromDeviceId === deviceId;
  if (!isOwner) {
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
  }
  const filtered = all.filter(m => m.id !== req.params.id);
  await saveJson(CHAT_DIRECT_KEY, filtered);
  res.json({ ok: true });
});

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

function turkishUpper(str) {
  return (str || '').replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
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
    `<text x="60" y="${startY + i * lineHeight}" font-family="Arial, sans-serif" font-size="56" font-weight="900" fill="#ffffff" letter-spacing="1">${escXml(line)}</text>`
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

function makeListApi(name, key) {
  app.get(`/api/${name}`, async (req, res) => {
    res.json({ items: (await loadJson(key)).slice().reverse() });
  });

  app.post(`/api/${name}`, upload.single('attachment'), async (req, res) => {
    const { password, ...fields } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    let attachment;
    try {
      attachment = await attachmentFromFile(req.file);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message || 'Dosya yüklenemedi.' });
    }
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

  app.put(`/api/${name}/:id`, async (req, res) => {
    const { password, ...fields } = req.body;
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
    const items = await loadJson(key);
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
    Object.assign(item, fields);
    item.editedAt = new Date().toISOString();
    await saveJson(key, items);
    res.json({ ok: true, item });
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

const MENU_KEY = 'cafeteria-menu';
app.get('/api/menu', async (req, res) => {
  res.json({ items: await loadJson(MENU_KEY) });
});

app.post('/api/menu', async (req, res) => {
  const { password, date, dishes } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'Geçersiz tarih.' });
  if (!Array.isArray(dishes)) return res.status(400).json({ ok: false, error: 'Geçersiz menü.' });
  const cleanDishes = dishes.slice(0, 4).map(d => (d || '').trim());
  if (cleanDishes.every(d => !d)) return res.status(400).json({ ok: false, error: 'En az bir yemek girilmeli.' });

  const items = await loadJson(MENU_KEY);
  let item = items.find(i => i.date === date);
  if (item) {
    item.dishes = cleanDishes;
    item.editedAt = new Date().toISOString();
  } else {
    item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date, dishes: cleanDishes, createdAt: new Date().toISOString() };
    items.push(item);
  }
  await saveJson(MENU_KEY, items);
  res.json({ ok: true, item });
});

app.delete('/api/menu/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const items = (await loadJson(MENU_KEY)).filter(i => i.id !== req.params.id);
  await saveJson(MENU_KEY, items);
  res.json({ ok: true });
});

const CALENDAR_KEY = 'calendar';
app.get('/api/calendar', async (req, res) => {
  res.json({ items: await loadJson(CALENDAR_KEY) });
});

app.post('/api/calendar', async (req, res) => {
  const { password, date, text, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'Geçersiz tarih.' });
  if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'Not boş olamaz.' });
  const items = await loadJson(CALENDAR_KEY);
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date, text: text.trim(), category: category || 'genel', createdAt: new Date().toISOString() };
  items.push(item);
  await saveJson(CALENDAR_KEY, items.slice(-3000));
  res.json({ ok: true, item });
});

app.delete('/api/calendar/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const items = (await loadJson(CALENDAR_KEY)).filter(i => i.id !== req.params.id);
  await saveJson(CALENDAR_KEY, items);
  res.json({ ok: true });
});

// --- ŞİFRE VE KULLANICI KESİTİ ---
const SELF_ACCOUNTS_KEY = 'self-accounts';
const SELF_OTP_KEY = 'self-otp-codes';
const SELF_TOKENS_KEY = 'self-tokens';
const SELF_ALLOWED_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com'];
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || 'duyuru-koprusu-2026-cok-gizli-anahtar-degistir';
const BRIDGE_URL = process.env.BRIDGE_URL || 'https://salihozgen.com/yemekhane/anket/api_kayitlarim.php';

function hashPassword(sifre) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(sifre, salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(sifre, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const testHash = crypto.scryptSync(sifre, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(testHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function emailDomainGecerliMi(email) {
  const m = /^[^@\s]+@([^@\s]+)$/.exec((email || '').trim().toLowerCase());
  return !!(m && SELF_ALLOWED_EMAIL_DOMAINS.includes(m[1]));
}

async function selfOtpGonder(email) {
  const kod = String(Math.floor(100000 + Math.random() * 900000));
  const codes = await loadJson(SELF_OTP_KEY);
  codes.push({ email, kod, olusturulma: Date.now(), sonKullanma: Date.now() + 10 * 60 * 1000, kullanildi: false, denemeSayisi: 0 });
  await saveJson(SELF_OTP_KEY, codes.slice(-500));

  if (!resend) return false;
  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: `Doğrulama Kodunuz: ${kod}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;text-align:center;padding:24px;">
        <h2 style="color:#0B2A4C;">Doğrulama Kodunuz</h2>
        <div style="font-size:2.2rem;font-weight:800;letter-spacing:8px;color:#EF7D1B;margin:14px 0;">${kod}</div>
        <p style="color:#888;font-size:12px;">Bu kod 10 dakika geçerlidir.</p>
      </div>`,
    });
    return true;
  } catch (err) {
    console.error('OTP mail gönderilemedi:', err.message);
    return false;
  }
}

app.post('/api/self-register', async (req, res) => {
  const adSoyad = (req.body.adSoyad || '').trim();
  const telefon = (req.body.telefon || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const sifre = req.body.sifre || '';

  if (adSoyad.length < 3) return res.status(400).json({ ok: false, error: 'Adınızı soyadınızı girin.' });
  if (telefon.replace(/\D/g, '').length < 10) return res.status(400).json({ ok: false, error: 'Geçerli telefon numarası girin.' });
  if (!emailDomainGecerliMi(email)) return res.status(400).json({ ok: false, error: 'Yalnızca Gmail veya Hotmail kabul edilmektedir.' });
  if (sifre.length < 6) return res.status(400).json({ ok: false, error: 'Şifre en az 6 karakter olmalı.' });

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  let acc = accounts.find(a => a.email === email);
  if (acc && acc.emailDogrulandi) {
    return res.status(400).json({ ok: false, error: 'Bu e-posta zaten kayıtlı.' });
  }
  const sifreHash = hashPassword(sifre);
  if (acc) {
    acc.adSoyad = adSoyad; acc.telefon = telefon; acc.sifreHash = sifreHash;
  } else {
    acc = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), adSoyad, telefon, email, sifreHash, emailDogrulandi: false, olusturulma: new Date().toISOString() };
    accounts.push(acc);
  }
  await saveJson(SELF_ACCOUNTS_KEY, accounts);
  await selfOtpGonder(email);
  res.json({ ok: true });
});

app.post('/api/self-verify', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const kod = (req.body.kod || '').trim();

  const codes = await loadJson(SELF_OTP_KEY);
  const kodKaydi = codes.slice().reverse().find(c => c.email === email && !c.kullanildi);
  if (!kodKaydi) return res.status(400).json({ ok: false, error: 'Geçerli kod bulunamadı.' });
  if (kodKaydi.denemeSayisi >= 5) return res.status(400).json({ ok: false, error: 'Çok fazla yanlış deneme yapıldı.' });
  if (Date.now() > kodKaydi.sonKullanma) return res.status(400).json({ ok: false, error: 'Kod süresi dolmuş.' });
  if (kod !== kodKaydi.kod) {
    kodKaydi.denemeSayisi = (kodKaydi.denemeSayisi || 0) + 1;
    await saveJson(SELF_OTP_KEY, codes);
    return res.status(400).json({ ok: false, error: 'Kod hatalı.' });
  }
  kodKaydi.kullanildi = true;
  await saveJson(SELF_OTP_KEY, codes);

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email);
  if (!acc) return res.status(404).json({ ok: false, error: 'Hesap bulunamadı.' });
  acc.emailDogrulandi = true;
  await saveJson(SELF_ACCOUNTS_KEY, accounts);
  res.json({ ok: true });
});

app.post('/api/self-resend', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const codes = await loadJson(SELF_OTP_KEY);
  const son = codes.slice().reverse().find(c => c.email === email);
  if (son && Date.now() - son.olusturulma < 45 * 1000) {
    return res.status(429).json({ ok: false, error: 'Lütfen bekleyin.' });
  }
  const gonderildi = await selfOtpGonder(email);
  res.json({ ok: true, mailSent: gonderildi });
});

// --- ŞİFREMİ UNUTTUM & SIFIRLAMA API (GÜNCELLENDİ) ---
app.post('/api/self-forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email && a.emailDogrulandi);
  if (!acc) return res.status(404).json({ ok: false, error: 'Kayıtlı ve doğrulanmış hesap bulunamadı.' });
  const ok = await selfOtpGonder(email);
  res.json({ ok: true, mailSent: ok });
});

app.post('/api/self-reset-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const kod = (req.body.kod || '').trim();
  const yeniSifre = req.body.yeniSifre || '';

  if (yeniSifre.length < 6) return res.status(400).json({ ok: false, error: 'Yeni şifre en az 6 karakter olmalı.' });

  const codes = await loadJson(SELF_OTP_KEY);
  const kodKaydi = codes.slice().reverse().find(c => c.email === email && !c.kullanildi);
  if (!kodKaydi) return res.status(400).json({ ok: false, error: 'Geçerli kod bulunamadı.' });
  if (kodKaydi.denemeSayisi >= 5) return res.status(400).json({ ok: false, error: 'Çok fazla deneme yapıldı.' });
  if (Date.now() > kodKaydi.sonKullanma) return res.status(400).json({ ok: false, error: 'Kod süresi dolmuş.' });
  if (kod !== kodKaydi.kod) {
    kodKaydi.denemeSayisi = (kodKaydi.denemeSayisi || 0) + 1;
    await saveJson(SELF_OTP_KEY, codes);
    return res.status(400).json({ ok: false, error: 'Kod hatalı.' });
  }
  kodKaydi.kullanildi = true;
  await saveJson(SELF_OTP_KEY, codes);

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email);
  if (!acc) return res.status(404).json({ ok: false, error: 'Hesap bulunamadı.' });
  acc.sifreHash = hashPassword(yeniSifre);
  await saveJson(SELF_ACCOUNTS_KEY, accounts);
  res.json({ ok: true });
});

app.post('/api/self-login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const sifre = req.body.sifre || '';
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email);
  if (!acc || !acc.emailDogrulandi || !verifyPassword(sifre, acc.sifreHash)) {
    return res.status(401).json({ ok: false, error: 'E-posta veya şifre hatalı.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const tokens = await loadJson(SELF_TOKENS_KEY, {});
  tokens[token] = { email, olusturulma: Date.now() };
  await saveJson(SELF_TOKENS_KEY, tokens);
  res.json({ ok: true, token, adSoyad: acc.adSoyad, telefon: acc.telefon });
});

async function selfAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
  const tokens = await loadJson(SELF_TOKENS_KEY, {});
  const entry = tokens[token];
  if (!entry) return res.status(401).json({ ok: false, error: 'Giriş yapmalısınız.' });
  req.selfEmail = entry.email;
  next();
}

app.get('/api/my-meals', selfAuthMiddleware, async (req, res) => {
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === req.selfEmail);
  if (!acc) return res.status(404).json({ ok: false, error: 'Hesap bulunamadı.' });

  try {
    const bridgeRes = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': BRIDGE_SECRET },
      body: JSON.stringify({ telefon: acc.telefon }),
    });
    const data = await bridgeRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Yemekhane sistemine ulaşılamıyor.' });
  }
});

app.get('/api/messages/:id/comments', async (req, res) => {
  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const comments = commentsMap[req.params.id] || [];
  let myEmail = null;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token) {
    const tokens = await loadJson(SELF_TOKENS_KEY, {});
    if (tokens[token]) myEmail = tokens[token].email;
  }
  const safeComments = comments.map(c => ({
    id: c.id, userName: c.userName, text: c.text, time: c.time, editedAt: c.editedAt || null,
    mine: !!(myEmail && c.email === myEmail),
  }));
  res.json({ comments: safeComments });
});

app.post('/api/messages/:id/comments', selfAuthMiddleware, async (req, res) => {
  const { text } = req.body;
  const cleanText = (text || '').trim().slice(0, 180);
  if (!cleanText) return res.status(400).json({ ok: false, error: 'Yorum metni boş olamaz.' });

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === req.selfEmail);
  const userName = acc ? acc.adSoyad : 'Kullanıcı';

  const commentsMap = await loadJson(COMMENTS_KEY, {});
  if (!commentsMap[req.params.id]) commentsMap[req.params.id] = [];

  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    userName,
    email: req.selfEmail,
    text: cleanText,
    time: new Date().toISOString()
  };

  commentsMap[req.params.id].push(comment);
  if (commentsMap[req.params.id].length > 200) {
    commentsMap[req.params.id] = commentsMap[req.params.id].slice(-200);
  }
  await saveJson(COMMENTS_KEY, commentsMap);

  res.json({ ok: true, comment });
});

app.put('/api/messages/:msgId/comments/:commentId', selfAuthMiddleware, async (req, res) => {
  const cleanText = (req.body.text || '').trim().slice(0, 180);
  if (!cleanText) return res.status(400).json({ ok: false, error: 'Yorum metni boş olamaz.' });

  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const list = commentsMap[req.params.msgId] || [];
  const comment = list.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
  if (comment.email !== req.selfEmail) return res.status(403).json({ ok: false, error: 'İzin yok.' });

  comment.text = cleanText;
  comment.editedAt = new Date().toISOString();
  await saveJson(COMMENTS_KEY, commentsMap);
  res.json({ ok: true, comment });
});

app.delete('/api/messages/:msgId/comments/:commentId', selfAuthMiddleware, async (req, res) => {
  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const list = commentsMap[req.params.msgId] || [];
  const comment = list.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
  if (comment.email !== req.selfEmail) return res.status(403).json({ ok: false, error: 'İzin yok.' });

  commentsMap[req.params.msgId] = list.filter(c => c.id !== req.params.commentId);
  await saveJson(COMMENTS_KEY, commentsMap);
  res.json({ ok: true });
});

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint bulunamadı: ' + req.method + ' ' + req.originalUrl });
});

app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Dosya çok büyük.' : 'Dosya yüklenemedi.';
    return res.status(400).json({ ok: false, error: msg });
  }
  if (err) {
    console.error('Beklenmeyen hata:', err.message);
    return res.status(500).json({ ok: false, error: 'Sunucu hatası oluştu.' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ofis Duyuru Sistemi aktif: http://localhost:${PORT}`));
