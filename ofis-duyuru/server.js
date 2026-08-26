const express = require('express');
const webpush = require('web-push');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Yüklenen dosyalar artık diske değil, belleğe alınıp Redis'e kaydediliyor
// (aynı JSON verileri gibi kalıcı olsun diye — disk her deploy'da siliniyordu).
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

// Dosyayı kalıcı depoya (Redis) kaydeder, dosya adını döner.
// Resimleri Upstash'in 10 MB istek sınırının altında kalması için küçültüp sıkıştırır.
// PDF'lere dokunmaz (sharp resim işleyemez), sadece resim dosyalarında devreye girer.
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

  // Upstash'in 10 MB istek sınırını base64 + JSON zarfıyla birlikte aşmayalım (güvenli pay için 9 MB'ta kes).
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
    // Fallback: Upstash yoksa yerel diske yaz (kalıcı olmaz)
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

// Kalıcı depodaki (Redis) dosyaları servis eder. Yerel fallback modunda
// express.static zaten public/uploads'ı karşılıyor, buraya hiç düşmez.
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

// --- E-POSTA (Resend) — uygulamayı henüz kurmamış kişilere ulaşmak için ücretsiz yedek kanal ---
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
        <p style="font-size:11px; color:#888; margin-top:20px;">Bu e-posta, Amasya CSB Acil Duyuru Sistemi tarafından otomatik gönderilmiştir. Anlık bildirim almak için uygulamayı telefonunuza kurabilirsiniz.</p>
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

// --- ÜYELER (hesap bazlı, tekilleştirilmiş — Kişiye Özel Mesaj ve admin genel bakış için) ---
app.get('/api/personnel/accounts', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const profiles = await loadJson(PROFILES_KEY, {});
  const presence = await loadJson(PRESENCE_KEY, {});
  const now = Date.now();
  const list = accounts.map(a => {
    const deviceIds = Object.entries(profiles).filter(([, p]) => p.accountEmail === a.email).map(([id]) => id);
    let lastSeen = null;
    deviceIds.forEach(id => { if (presence[id] && (!lastSeen || presence[id] > lastSeen)) lastSeen = presence[id]; });
    let avatar = null;
    deviceIds.forEach(id => { if (!avatar && profiles[id] && profiles[id].avatar) avatar = profiles[id].avatar; });
    return {
      email: a.email,
      adSoyad: a.adSoyad,
      telefon: a.telefon,
      emailDogrulandi: !!a.emailDogrulandi,
      olusturulma: a.olusturulma,
      deviceCount: deviceIds.length,
      online: lastSeen ? (now - lastSeen < 10 * 60 * 1000) : false,
      lastSeen,
      avatar,
    };
  }).sort((a, b) => (b.online - a.online) || (b.olusturulma || '').localeCompare(a.olusturulma || ''));
  res.json({ accounts: list });
});

// --- İZİNLİ TELEFONLAR (admin tarafından yönetilir) ---
// Yeni üye kaydı sırasında, telefon numarası kurum köprüsünde (PHP personel tablosu) bulunamazsa
// bu listeye de bakılır. PHP tarafında henüz görünmeyen yeni işe başlayanlar için kullanışlı.
app.get('/api/allowed-phones', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  const list = (await loadJson(ALLOWED_PHONES_KEY)).slice().reverse();
  res.json({ items: list });
});

app.post('/api/allowed-phones', async (req, res) => {
  const { password, name, telefon } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const cleanName = (name || '').trim();
  const cleanPhone = (telefon || '').trim();
  if (!cleanName || cleanPhone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ ok: false, error: 'İsim ve geçerli bir telefon numarası gerekli.' });
  }
  const list = await loadJson(ALLOWED_PHONES_KEY);
  const son10 = cleanPhone.replace(/\D/g, '').slice(-10);
  if (list.some(a => a.telefon.replace(/\D/g, '').slice(-10) === son10)) {
    return res.status(400).json({ ok: false, error: 'Bu telefon numarası zaten listede.' });
  }
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: cleanName, telefon: cleanPhone, addedAt: new Date().toISOString() };
  list.push(item);
  await saveJson(ALLOWED_PHONES_KEY, list);
  res.json({ ok: true, item });
});

app.delete('/api/allowed-phones/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const list = (await loadJson(ALLOWED_PHONES_KEY)).filter(a => a.id !== req.params.id);
  await saveJson(ALLOWED_PHONES_KEY, list);
  res.json({ ok: true });
});

// --- TOPLU PERSONEL EKLEME (elle, uygulama kurmamış kişiler için — sadece e-posta ile ulaşılabilir) ---
app.post('/api/personnel/bulk-add', async (req, res) => {
  const { password, entries } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ ok: false, error: 'Eklenecek kişi listesi boş.' });
  }

  const profiles = await loadJson(PROFILES_KEY, {});

  function normName(s) { return (s || '').toLocaleLowerCase('tr').trim().replace(/\s+/g, ' '); }
  function normPhone(s) { return (s || '').replace(/\D/g, ''); }

  const existing = Object.values(profiles).map(p => ({ name: normName(p.name), phone: normPhone(p.phone) }));

  let added = 0;
  const errors = [];
  const duplicates = [];

  for (const entry of entries) {
    const name = (entry.name || '').trim();
    const phone = (entry.phone || '').trim();
    const email = (entry.email || '').trim();
    if (!name) { errors.push('İsimsiz satır atlandı.'); continue; }
    if (!phone && !email) { errors.push(`"${name}" için telefon veya e-posta yok, atlandı.`); continue; }

    const nName = normName(name);
    const nPhone = normPhone(phone);
    const isDup = nPhone && existing.some(e => e.name === nName && e.phone === nPhone);
    if (isDup) { duplicates.push(name); continue; }

    const deviceId = 'manual-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    profiles[deviceId] = {
      name,
      phone: phone || null,
      email: email || null,
      bloodType: null,
      manual: true,
      addedAt: new Date().toISOString(),
    };
    existing.push({ name: nName, phone: nPhone });
    added++;
  }

  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true, added, errors, duplicates });
});

// --- ELLE EKLENEN (henüz uygulama kurmamış) PERSONEL LİSTESİ ---
app.get('/api/personnel/manual', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  const profiles = await loadJson(PROFILES_KEY, {});
  const manual = Object.entries(profiles)
    .filter(([, p]) => p.manual)
    .map(([deviceId, p]) => ({ deviceId, name: p.name, phone: p.phone, email: p.email, addedAt: p.addedAt }))
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  res.json({ personnel: manual });
});

app.delete('/api/personnel/manual/:deviceId', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const profiles = await loadJson(PROFILES_KEY, {});
  delete profiles[req.params.deviceId];
  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true });
});

app.put('/api/personnel/manual/:deviceId', async (req, res) => {
  const { password, name, phone, email } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!name || !name.trim()) return res.status(400).json({ ok: false, error: 'Adı Soyadı zorunlu.' });
  const profiles = await loadJson(PROFILES_KEY, {});
  const p = profiles[req.params.deviceId];
  if (!p) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
  p.name = name.trim();
  p.phone = (phone || '').trim() || null;
  p.email = (email || '').trim() || null;
  p.editedAt = new Date().toISOString();
  await saveJson(PROFILES_KEY, profiles);
  res.json({ ok: true });
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

// --- KAN BANKASI: acil durumda, izin veren personeli kan grubuna göre arayabilme ---
// Sadece "bloodDonorOptIn: true" işaretlemiş kişiler listelenir — kan grubu girmiş olmak tek başına yeterli değildir,
// telefon numarasının diğer personele görünmesine açıkça izin vermiş olmaları gerekir.
app.get('/api/blood-bank', async (req, res) => {
  const type = (req.query.type || '').trim();
  const profiles = await loadJson(PROFILES_KEY, {});
  const results = Object.values(profiles)
    .filter(p => p.bloodDonorOptIn && p.bloodType && p.name && p.phone)
    .filter(p => !type || p.bloodType === type)
    .map(p => ({ name: p.name, phone: p.phone, bloodType: p.bloodType }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
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
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'Adınızı ve soyadınızı girmelisiniz.' });
  if (!text) return res.status(400).json({ ok: false, error: 'Boş gönderilemez.' });
  const list = await loadJson(FEEDBACK_KEY);
  const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, name, phone: phone || null, email: email || null, time: new Date().toISOString() };
  list.push(item);
  await saveJson(FEEDBACK_KEY, list.slice(-200));
  res.json({ ok: true });

  // --- İletişim formu bildirimi: her mesaj anında salihozgen35@gmail.com'a e-postayla düşer ---
  // (Doğum/vefat gibi acil konular buradan da gelebileceği için beklemeden, arka planda gönderiyoruz;
  // e-posta gönderimi başarısız olsa bile kullanıcıya verilen cevabı etkilemez.)
  if (resend) {
    const mailPayload = {
      from: RESEND_FROM,
      to: 'salihozgen35@gmail.com',
      subject: `📩 Yeni İletişim Formu Mesajı${name ? ' — ' + name : ''}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#7A2331;">Yeni bir mesaj geldi</h2>
        <p><b>Gönderen:</b> ${name ? name.replace(/</g, '&lt;') : 'İsimsiz'}</p>
        ${phone ? `<p><b>Telefon:</b> ${phone.replace(/</g, '&lt;')}</p>` : ''}
        ${email ? `<p><b>E-posta:</b> ${email.replace(/</g, '&lt;')}</p>` : ''}
        <p><b>Zaman:</b> ${new Date(item.time).toLocaleString('tr-TR')}</p>
        <div style="background:#f7f5f0; border-radius:8px; padding:14px 16px; margin-top:10px; white-space:pre-wrap; color:#1F2430;">${text.replace(/</g, '&lt;')}</div>
        <p style="color:#999; font-size:12px; margin-top:16px;">Bu mesaj Görüş &amp; İletişim formu üzerinden otomatik gönderilmiştir.${email ? ' Bu e-postayı doğrudan "Yanıtla" ile cevaplayabilirsiniz.' : (phone ? ' Yukarıdaki numaradan geri dönüş yapabilirsiniz.' : ' Gönderene ait bir iletişim bilgisi paylaşılmadıysa yönetim panelinden bakabilirsiniz.')}</p>
      </div>`,
    };
    // E-posta girildiyse "Yanıtla" butonu doğrudan gönderene gitsin diye reply-to olarak ayarlıyoruz.
    if (email) mailPayload.reply_to = email;
    resend.emails.send(mailPayload).catch(err => console.error('İletişim formu e-postası gönderilemedi:', err.message));
  }
});

app.get('/api/feedback', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ items: (await loadJson(FEEDBACK_KEY)).slice().reverse() });
});

app.put('/api/feedback/:id', async (req, res) => {
  const { password, text, name } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!text || !text.trim()) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });
  const list = await loadJson(FEEDBACK_KEY);
  const item = list.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
  item.text = text.trim();
  item.name = (name || '').trim() || null;
  item.editedAt = new Date().toISOString();
  await saveJson(FEEDBACK_KEY, list);
  res.json({ ok: true, item });
});

app.delete('/api/feedback/:id', async (req, res) => {
  const { password } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const list = (await loadJson(FEEDBACK_KEY)).filter(i => i.id !== req.params.id);
  await saveJson(FEEDBACK_KEY, list);
  res.json({ ok: true });
});

// ============================================================================
// ANKET (POLL) — yönetici anket açar, her cihaz (deviceId) yalnızca 1 kez oy
// kullanabilir. Oylar sunucuda deviceId->seçenek eşlemesiyle tutulur, bu yüzden
// aynı cihaz sayfayı yenileyip tekrar oy vermeye çalışsa bile engellenir.
// ============================================================================
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
    voters: {}, // { deviceId: optionIndex }
    active: true,
    createdAt: new Date().toISOString(),
  };
  polls.push(poll);
  await saveJson(POLLS_KEY, polls);
  res.json({ ok: true, poll });
});

// Yönetici: tüm anketleri (oy dağılımlarıyla) listeler.
app.get('/api/polls', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ polls: (await loadJson(POLLS_KEY)).slice().reverse() });
});

// Herkese açık: sadece aktif anketleri, bu cihazın daha önce oy kullanıp kullanmadığı bilgisiyle döner.
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
  if (!poll.active) return res.status(400).json({ ok: false, error: 'Bu anket kapatılmış, artık oy kullanılamaz.' });
  if (isNaN(idx) || idx < 0 || idx >= poll.options.length) return res.status(400).json({ ok: false, error: 'Geçersiz seçenek.' });
  if (!poll.voters) poll.voters = {};
  if (poll.voters[deviceId] !== undefined) return res.status(400).json({ ok: false, error: 'Bu cihazdan bu ankete zaten oy kullanılmış.' });

  poll.voters[deviceId] = idx;
  poll.options[idx].votes = (poll.options[idx].votes || 0) + 1;
  await saveJson(POLLS_KEY, polls);

  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  res.json({
    ok: true,
    poll: { id: poll.id, question: poll.question, options: poll.options.map(o => ({ text: o.text, votes: o.votes })), myVote: idx, totalVotes: total },
  });
});

// Yönetici: anketi kapat/yeniden aç.
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

// --- CİHAZ SİLME (test/gereksiz aboneliklerini temizlemek için) ---
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

app.post('/api/send', upload.array('attachments', 6), async (req, res) => {
  const { password, category, title, body, alsoEmail, date, videoUrl } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });
  const cleanVideoUrl = (videoUrl || '').trim();
  if (cleanVideoUrl && !/^https?:\/\//i.test(cleanVideoUrl)) {
    return res.status(400).json({ ok: false, error: 'Video linki http:// veya https:// ile başlamalı.' });
  }

  // Birden fazla dosya (galeri) desteği — ilki manşet/bildirim kapağı olarak kullanılır.
  let attachments = [];
  try {
    for (const file of (req.files || [])) {
      const a = await attachmentFromFile(file);
      if (a) attachments.push({ ...a, likedBy: [] });
    }
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Dosya yüklenemedi.' });
  }
  const attachment = attachments.find(a => a.type === 'image') || attachments[0] || null;

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

  // Admin isterse duyuruya geçmişe dönük ya da ileri bir tarih verebilir; boşsa şimdiki zaman kullanılır.
  const finalTime = (date && !isNaN(Date.parse(date))) ? new Date(date).toISOString() : new Date().toISOString();

  const messages = await loadJson(MESSAGES_KEY);
  messages.push({ id: messageId, category: category || 'genel', title, body, time: finalTime, attachment, attachments, videoUrl: cleanVideoUrl || null, reads: [] });
  await saveJson(MESSAGES_KEY, messages.slice(-100));

  let emailResult = null;
  if (alsoEmail === 'true' || alsoEmail === true) {
    emailResult = await sendAnnouncementEmails(title, body, category || 'genel');
  }

  res.json({ ok: true, sent, totalSubscribers: stillValid.length, messageId, email: emailResult });
});

// --- KİŞİYE ÖZEL (HEDEFLİ) BİLDİRİM GÖNDERME ---
app.post('/api/send-to', upload.single('attachment'), async (req, res) => {
  const { password, deviceId, email, title, body, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!deviceId && !email) return res.status(400).json({ ok: false, error: 'Kişi seçilmedi.' });
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });

  // Hesap (email) seçildiyse, o hesaba bağlı TÜM cihazlara gönderiyoruz (kişi hangi cihazı
  // kullanıyorsa ulaşsın); tek bir cihaz seçildiyse (Cihazlar listesinden) eskisi gibi sadece ona.
  let targetDeviceIds = [];
  if (email) {
    const profiles = await loadJson(PROFILES_KEY, {});
    targetDeviceIds = Object.entries(profiles).filter(([, p]) => p.accountEmail === email).map(([id]) => id);
    if (targetDeviceIds.length === 0) return res.status(404).json({ ok: false, error: 'Bu üyeye bağlı hiçbir cihaz bulunamadı.' });
  } else {
    targetDeviceIds = [deviceId];
  }

  const subs = await loadJson(SUBS_KEY);
  const targetSubs = subs.filter(s => targetDeviceIds.includes(s.deviceId));
  if (targetSubs.length === 0) return res.status(404).json({ ok: false, error: 'Bu kişiye ait aktif bildirim aboneliği bulunamadı.' });

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
    } catch (err) {
      // sessizce yut, hedefli mesajlarda ana abonelik listesini bozmayalım
    }
  }

  const direct = await loadJson(DIRECT_KEY);
  direct.push({ id: messageId, deviceId: targetDeviceIds[0], category: category || 'genel', title, body, time: new Date().toISOString(), attachment });
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

// --- DUYURU DÜZENLEME (yeni bildirim GÖNDERMEZ, sadece metni günceller) ---
app.put('/api/messages/:id', upload.array('newAttachments', 6), async (req, res) => {
  const { password, title, body, category, date, removeUrls, coverUrl, videoUrl } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });
  if (videoUrl && videoUrl.trim() && !/^https?:\/\//i.test(videoUrl.trim())) {
    return res.status(400).json({ ok: false, error: 'Video linki http:// veya https:// ile başlamalı.' });
  }

  const messages = await loadJson(MESSAGES_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Duyuru bulunamadı.' });

  msg.title = title;
  msg.body = body;
  if (category) msg.category = category;
  if (date && !isNaN(Date.parse(date))) msg.time = new Date(date).toISOString();
  if (videoUrl !== undefined) msg.videoUrl = videoUrl.trim() || null;

  // Mevcut galeriden kaldırılmak istenenleri çıkar.
  if (!Array.isArray(msg.attachments)) msg.attachments = msg.attachment ? [msg.attachment] : [];
  if (removeUrls) {
    try {
      const toRemove = JSON.parse(removeUrls);
      if (Array.isArray(toRemove) && toRemove.length) {
        msg.attachments = msg.attachments.filter(a => !toRemove.includes(a.url));
      }
    } catch (e) {}
  }

  // Yeni yüklenen dosyaları galeriye ekle.
  try {
    for (const file of (req.files || [])) {
      const a = await attachmentFromFile(file);
      if (a) msg.attachments.push({ ...a, likedBy: [] });
    }
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'Dosya yüklenemedi.' });
  }

  // Admin belirli bir görseli manşet (kapak) olarak seçtiyse, galeri dizisinin başına taşı.
  if (coverUrl) {
    const idx = msg.attachments.findIndex(a => a.url === coverUrl);
    if (idx > 0) {
      const [chosen] = msg.attachments.splice(idx, 1);
      msg.attachments.unshift(chosen);
    }
  }

  // Manşet/bildirim kapağı olarak ilk görseli kullan (geriye dönük uyumluluk için `attachment` alanı).
  msg.attachment = msg.attachments.find(a => a.type === 'image') || msg.attachments[0] || null;

  msg.editedAt = new Date().toISOString();

  await saveJson(MESSAGES_KEY, messages);
  res.json({ ok: true, message: msg });
});

// --- DUYURU GÖRSELİNE BEĞENİ (galeri fotoğrafları için) ---
app.post('/api/messages/:id/attachments/:idx/like', async (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const idx = parseInt(req.params.idx, 10);
  const messages = await loadJson(MESSAGES_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg || !Array.isArray(msg.attachments) || !msg.attachments[idx]) {
    return res.status(404).json({ ok: false, error: 'Görsel bulunamadı.' });
  }
  const att = msg.attachments[idx];
  if (!att.likedBy) att.likedBy = [];
  const already = att.likedBy.includes(deviceId);
  if (already) att.likedBy = att.likedBy.filter(d => d !== deviceId);
  else att.likedBy.push(deviceId);
  // Kapak görseli de galerideki ilk resimle aynı referansı paylaşıyor olabilir, senkron tutalım.
  if (msg.attachment && msg.attachment.url === att.url) msg.attachment.likedBy = att.likedBy;
  await saveJson(MESSAGES_KEY, messages);
  res.json({ ok: true, liked: !already, likeCount: att.likedBy.length });
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
    .filter(([, ts]) => now - ts < 10 * 60 * 1000)
    .map(([deviceId]) => deviceId);
  res.json({ online });
});

// --- SOHBET İÇİN KİŞİ LİSTESİ (profilini tamamlamış herkes) ---
// --- SOHBET KİŞİ LİSTESİ (hesap bazlı — aynı kişi birden fazla cihazdan girmiş olsa da TEK satır) ---
app.get('/api/chat/contacts', selfAuthMiddleware, async (req, res) => {
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const profiles = await loadJson(PROFILES_KEY, {});
  const presence = await loadJson(PRESENCE_KEY, {});
  const now = Date.now();

  const contacts = accounts
    .filter(a => a.emailDogrulandi && a.email !== req.selfEmail)
    .map(a => {
      const deviceIds = Object.entries(profiles).filter(([, p]) => p.accountEmail === a.email).map(([id]) => id);
      let lastSeen = null;
      deviceIds.forEach(id => { if (presence[id] && (!lastSeen || presence[id] > lastSeen)) lastSeen = presence[id]; });
      let avatar = null;
      deviceIds.forEach(id => { if (!avatar && profiles[id] && profiles[id].avatar) avatar = profiles[id].avatar; });
      return {
        email: a.email,
        name: a.adSoyad,
        avatar,
        online: lastSeen ? (now - lastSeen < 10 * 60 * 1000) : false,
        lastSeen,
      };
    })
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'tr'));

  res.json({ contacts });
});

// --- GENEL SOHBET ODASI ---
app.get('/api/chat/general', async (req, res) => {
  const messages = (await loadJson(CHAT_GENERAL_KEY)).slice(-100);
  res.json({ messages });
});

app.post('/api/chat/general', selfAuthMiddleware, async (req, res) => {
  const { text, deviceId } = req.body;
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === req.selfEmail);
  const profiles = await loadJson(PROFILES_KEY, {});
  const avatar = (deviceId && profiles[deviceId] && profiles[deviceId].avatar) || null;

  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    email: req.selfEmail,
    name: acc ? acc.adSoyad : 'Kullanıcı',
    avatar,
    text: clean,
    time: new Date().toISOString(),
  };
  messages.push(msg);
  await saveJson(CHAT_GENERAL_KEY, messages.slice(-500));
  res.json({ ok: true, message: msg });
});

// --- BİREBİR ÖZEL SOHBET (hesap bazlı — hangi cihazdan bağlanırsa bağlansın aynı sohbet) ---
function conversationKey(a, b) { return [a, b].sort().join('__'); }

app.get('/api/chat/direct', selfAuthMiddleware, async (req, res) => {
  const withEmail = (req.query.withEmail || '').trim().toLowerCase();
  if (!withEmail) return res.status(400).json({ ok: false, error: 'Eksik parametre.' });
  const all = await loadJson(CHAT_DIRECT_KEY);
  const key = conversationKey(req.selfEmail, withEmail);
  const messages = all.filter(m => m.key === key).slice(-200);
  res.json({ messages });
});

app.post('/api/chat/direct', selfAuthMiddleware, async (req, res) => {
  const toEmail = (req.body.toEmail || '').trim().toLowerCase();
  const { text, deviceId } = req.body;
  if (!toEmail) return res.status(400).json({ ok: false, error: 'Alıcı belirtilmedi.' });
  const clean = (text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const myAcc = accounts.find(a => a.email === req.selfEmail);
  const toAcc = accounts.find(a => a.email === toEmail && a.emailDogrulandi);
  if (!toAcc) return res.status(404).json({ ok: false, error: 'Karşı taraf bulunamadı.' });

  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key: conversationKey(req.selfEmail, toEmail),
    fromEmail: req.selfEmail,
    toEmail,
    fromName: myAcc ? myAcc.adSoyad : 'Kullanıcı',
    text: clean,
    time: new Date().toISOString(),
  };
  all.push(msg);
  await saveJson(CHAT_DIRECT_KEY, all.slice(-2000));

  // Karşı tarafın BAĞLI OLDUĞU TÜM cihazlara push bildirimi gönder — hangi cihazı kullanıyorsa ulaşsın.
  const profiles = await loadJson(PROFILES_KEY, {});
  const toDeviceIds = Object.entries(profiles).filter(([, p]) => p.accountEmail === toEmail).map(([id]) => id);
  if (toDeviceIds.length) {
    const subs = (await loadJson(SUBS_KEY)).filter(s => toDeviceIds.includes(s.deviceId));
    if (subs.length) {
      const payload = JSON.stringify({
        id: msg.id,
        title: `💬 ${msg.fromName}`,
        body: clean,
        category: 'genel',
        urgent: false,
        personal: true,
      });
      subs.forEach(sub => { webpush.sendNotification(sub, payload, { TTL: 86400 }).catch(() => {}); });
    }
  }

  res.json({ ok: true, message: msg });
});

// --- SOHBET DENETİMİ (YÖNETİCİ) ---
app.get('/api/chat/general/all', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  res.json({ messages: (await loadJson(CHAT_GENERAL_KEY)).slice(-300).reverse() });
});

// --- KENDİ MESAJINI DÜZENLEME (Genel Oda) ---
app.put('/api/chat/general/:id', selfAuthMiddleware, async (req, res) => {
  const clean = (req.body.text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });
  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  if (msg.email !== req.selfEmail) return res.status(403).json({ ok: false, error: 'Sadece kendi mesajınızı düzenleyebilirsiniz.' });
  msg.text = clean;
  msg.editedAt = new Date().toISOString();
  await saveJson(CHAT_GENERAL_KEY, messages);
  res.json({ ok: true, message: msg });
});

// --- OKUNDU İŞARETLEME (Genel Oda, toplu) ---
app.post('/api/chat/general/read-bulk', selfAuthMiddleware, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false });
  const messages = await loadJson(CHAT_GENERAL_KEY);
  let changed = false;
  messages.forEach(m => {
    if (ids.includes(m.id) && m.email !== req.selfEmail) {
      if (!m.reads) m.reads = [];
      if (!m.reads.includes(req.selfEmail)) { m.reads.push(req.selfEmail); changed = true; }
    }
  });
  if (changed) await saveJson(CHAT_GENERAL_KEY, messages);
  res.json({ ok: true });
});

// Silme: hem mesaj sahibi (Bearer token ile) hem de yönetici (şifreyle) silebilir.
async function resolveSelfEmailFromHeader(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return null;
  const tokens = await loadJson(SELF_TOKENS_KEY, {});
  return (tokens[token] && tokens[token].email) || null;
}

app.delete('/api/chat/general/:id', async (req, res) => {
  const { password } = req.body;
  const selfEmail = await resolveSelfEmailFromHeader(req);
  const messages = await loadJson(CHAT_GENERAL_KEY);
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  const isOwner = selfEmail && msg.email === selfEmail;
  if (!isOwner) {
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
  }
  const filtered = messages.filter(m => m.id !== req.params.id);
  await saveJson(CHAT_GENERAL_KEY, filtered);
  res.json({ ok: true });
});

app.get('/api/chat/direct/all', async (req, res) => {
  const result = checkPassword(req.query.password, req);
  if (passwordCheckResponse(res, result)) return;
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const nameByEmail = {};
  accounts.forEach(a => { nameByEmail[a.email] = a.adSoyad; });
  const all = (await loadJson(CHAT_DIRECT_KEY)).slice(-300).reverse().map(m => ({
    ...m,
    fromLabel: nameByEmail[m.fromEmail] || m.fromName || 'Bilinmeyen',
    toLabel: nameByEmail[m.toEmail] || 'Bilinmeyen',
  }));
  res.json({ messages: all });
});

// --- KENDİ MESAJINI DÜZENLEME (Özel Sohbet) ---
app.put('/api/chat/direct/:id', selfAuthMiddleware, async (req, res) => {
  const clean = (req.body.text || '').trim().slice(0, 1000);
  if (!clean) return res.status(400).json({ ok: false, error: 'Mesaj boş olamaz.' });
  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = all.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  if (msg.fromEmail !== req.selfEmail) return res.status(403).json({ ok: false, error: 'Sadece kendi mesajınızı düzenleyebilirsiniz.' });
  msg.text = clean;
  msg.editedAt = new Date().toISOString();
  await saveJson(CHAT_DIRECT_KEY, all);
  res.json({ ok: true, message: msg });
});

// --- OKUNDU İŞARETLEME (Özel Sohbet, toplu) ---
app.post('/api/chat/direct/read-bulk', selfAuthMiddleware, async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false });
  const all = await loadJson(CHAT_DIRECT_KEY);
  let changed = false;
  all.forEach(m => {
    if (ids.includes(m.id) && m.toEmail === req.selfEmail && !m.read) {
      m.read = true;
      m.readAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) await saveJson(CHAT_DIRECT_KEY, all);
  res.json({ ok: true });
});

app.delete('/api/chat/direct/:id', async (req, res) => {
  const { password } = req.body;
  const selfEmail = await resolveSelfEmailFromHeader(req);
  const all = await loadJson(CHAT_DIRECT_KEY);
  const msg = all.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false, error: 'Mesaj bulunamadı.' });
  const isOwner = selfEmail && msg.fromEmail === selfEmail;
  if (!isOwner) {
    const result = checkPassword(password, req);
    if (passwordCheckResponse(res, result)) return;
  }
  const filtered = all.filter(m => m.id !== req.params.id);
  await saveJson(CHAT_DIRECT_KEY, filtered);
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

// --- YEMEKHANE MENÜSÜ (günlük, 4 çeşit yemek) ---
const MENU_KEY = 'cafeteria-menu';

app.get('/api/menu', async (req, res) => {
  res.json({ items: await loadJson(MENU_KEY) });
});

app.post('/api/menu', async (req, res) => {
  const { password, date, dishes } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'Geçersiz tarih.' });
  if (!Array.isArray(dishes)) return res.status(400).json({ ok: false, error: 'Menü listesi geçersiz.' });
  const cleanDishes = dishes.slice(0, 4).map(d => (d || '').trim());
  if (cleanDishes.every(d => !d)) return res.status(400).json({ ok: false, error: 'En az bir yemek girilmeli.' });

  const items = await loadJson(MENU_KEY);
  let item = items.find(i => i.date === date);
  if (item) {
    item.dishes = cleanDishes;
    item.editedAt = new Date().toISOString();
  } else {
    item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date, dishes: cleanDishes,
      createdAt: new Date().toISOString(),
    };
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

// --- TAKVİM (aylık/yıllık not/etkinlik takvimi) ---
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
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    date, text: text.trim(),
    category: category || 'genel',
    createdAt: new Date().toISOString(),
  };
  items.push(item);
  await saveJson(CALENDAR_KEY, items.slice(-3000));
  res.json({ ok: true, item });
});

app.put('/api/calendar/:id', async (req, res) => {
  const { password, text, date, category } = req.body;
  const result = checkPassword(password, req);
  if (passwordCheckResponse(res, result)) return;
  const items = await loadJson(CALENDAR_KEY);
  const item = items.find(i => i.id === req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
  if (text !== undefined) {
    if (!text.trim()) return res.status(400).json({ ok: false, error: 'Not boş olamaz.' });
    item.text = text.trim();
  }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) item.date = date;
  if (category) item.category = category;
  item.editedAt = new Date().toISOString();
  await saveJson(CALENDAR_KEY, items);
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

// ============================================================================
// KİŞİSEL HESAP (SELF-SERVİS KAYIT) — personelin kendi yemekhane kayıtlarını
// görebilmesi için. Ad-soyad + telefon + kişisel e-posta (yalnızca gmail.com/
// hotmail.com — kurumsal adresler kabul edilmez) + şifre ile kayıt olunur,
// e-postaya 6 haneli kod gönderilir. Doğrulanan hesap, telefon numarasıyla
// salihozgen.com/yemekhane/anket sistemindeki (PHP+MySQL) personel kaydına
// "köprü API" üzerinden eşleştirilip kendi yemek geçmişi gösterilir.
// ============================================================================
const crypto = require('crypto');

const SELF_ACCOUNTS_KEY = 'self-accounts';
const ALLOWED_PHONES_KEY = 'allowed-phones';
const SELF_OTP_KEY = 'self-otp-codes';
const SELF_TOKENS_KEY = 'self-tokens';
const SELF_ALLOWED_EMAIL_DOMAINS = ['gmail.com', 'hotmail.com'];

// ⚠️ BRIDGE_SECRET, PHP tarafındaki (api_kayitlarim.php) BRIDGE_SECRET ile
// BİREBİR AYNI olmalı. İkisini de ortam değişkeninden (env) okumak daha güvenli
// olur, ama bu kod tabanının geri kalanı gibi (ADMIN_PASSWORD vs.) burada da
// çalışır bir varsayılan değer bırakıyoruz.
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

  if (!resend) { console.warn('OTP kodu üretildi ama RESEND_API_KEY tanımlı değil, mail gönderilemedi:', email, kod); return false; }
  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: `Doğrulama Kodunuz: ${kod}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto;text-align:center;padding:24px;">
        <h2 style="color:#4338ca;">Doğrulama Kodunuz</h2>
        <div style="font-size:2rem;font-weight:800;letter-spacing:8px;color:#4338ca;margin:14px 0;">${kod}</div>
        <p style="color:#888;font-size:12px;">Bu kod 10 dakika geçerlidir. Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.</p>
      </div>`,
    });
    return true;
  } catch (err) {
    console.error('OTP mail gönderilemedi (' + email + '):', err.message);
    return false;
  }
}

app.post('/api/self-register', async (req, res) => {
  const adSoyad = (req.body.adSoyad || '').trim();
  const telefon = (req.body.telefon || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const sifre = req.body.sifre || '';

  if (adSoyad.length < 3) return res.status(400).json({ ok: false, error: 'Adınızı ve soyadınızı eksiksiz girin.' });
  if (telefon.replace(/\D/g, '').length < 10) return res.status(400).json({ ok: false, error: 'Geçerli bir telefon numarası girin.' });
  if (!emailDomainGecerliMi(email)) return res.status(400).json({ ok: false, error: 'Yalnızca kişisel Gmail veya Hotmail adresiyle kayıt olabilirsiniz. Kurumsal e-postalar kabul edilmiyor.' });
  if (sifre.length < 6) return res.status(400).json({ ok: false, error: 'Şifre en az 6 karakter olmalı.' });

  // --- KURUM DOĞRULAMASI: bu kurum içi bir uygulama, o yüzden yeni kayıt açan telefon numarası
  // ya kurumun personel listesiyle (PHP tarafındaki köprü üzerinden) eşleşmeli, ya da admin
  // panelinden elle eklenmiş "İzinli Telefonlar" listesinde olmalı (örn. PHP tarafında henüz
  // görünmeyen yeni işe başlayanlar için). İkisi de eşleşmezse kayıt reddedilir.
  const son10 = telefon.replace(/\D/g, '').slice(-10);
  const allowedList = await loadJson(ALLOWED_PHONES_KEY);
  const allowedMatch = allowedList.find(a => a.telefon.replace(/\D/g, '').slice(-10) === son10);

  if (!allowedMatch) {
    try {
      const bridgeRes = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': BRIDGE_SECRET },
        body: JSON.stringify({ telefon }),
      });
      const bridgeData = await bridgeRes.json();
      if (!bridgeData.ok) {
        return res.status(400).json({
          ok: false,
          error: 'Bu telefon numarası kurumumuzun personel kayıtlarıyla eşleşmiyor. Bu uygulama yalnızca kurum personeline özeldir — kaydınızın yapılabilmesi için lütfen sistem sorumlusuna (yönetici) telefon numaranızı bildirerek yazılı olarak ulaşın.',
        });
      }
    } catch (err) {
      console.error('Kayıt sırasında kurum doğrulaması yapılamadı:', err.message);
      return res.status(502).json({ ok: false, error: 'Kurum kayıtları şu an doğrulanamadı, lütfen daha sonra tekrar deneyin.' });
    }
  }

  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  let acc = accounts.find(a => a.email === email);
  if (acc && acc.emailDogrulandi) {
    return res.status(400).json({ ok: false, error: 'Bu e-posta zaten kayıtlı. Giriş yapmayı deneyin.' });
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
  if (!kodKaydi) return res.status(400).json({ ok: false, error: 'Geçerli bir kod bulunamadı. Yeni kod isteyin.' });
  if (kodKaydi.denemeSayisi >= 5) return res.status(400).json({ ok: false, error: 'Çok fazla yanlış deneme yapıldı. Yeni kod isteyin.' });
  if (Date.now() > kodKaydi.sonKullanma) return res.status(400).json({ ok: false, error: 'Kodun süresi dolmuş. Yeni kod isteyin.' });
  if (kod !== kodKaydi.kod) {
    kodKaydi.denemeSayisi = (kodKaydi.denemeSayisi || 0) + 1;
    await saveJson(SELF_OTP_KEY, codes);
    return res.status(400).json({ ok: false, error: 'Kod hatalı, tekrar deneyin.' });
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
    return res.status(429).json({ ok: false, error: 'Yeni kod istemeden önce birkaç saniye bekleyin.' });
  }
  const gonderildi = await selfOtpGonder(email);
  res.json({ ok: true, mailSent: gonderildi });
});

app.post('/api/self-login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const sifre = req.body.sifre || '';
  const deviceId = (req.body.deviceId || '').trim();
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email);
  if (!acc || !acc.emailDogrulandi || !verifyPassword(sifre, acc.sifreHash)) {
    return res.status(401).json({ ok: false, error: 'E-posta veya şifre hatalı ya da hesap henüz doğrulanmamış.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const tokens = await loadJson(SELF_TOKENS_KEY, {});
  tokens[token] = { email, olusturulma: Date.now() };
  await saveJson(SELF_TOKENS_KEY, tokens);

  // Bu cihazı hesaba bağlıyoruz — kişi telefonundan da tarayıcısından da giriş yapsa,
  // sohbet/üye listesinde TEK kişi olarak görünsün diye (çoklu satır sorunu buradan çözülüyor).
  if (deviceId) {
    const profiles = await loadJson(PROFILES_KEY, {});
    if (!profiles[deviceId]) profiles[deviceId] = {};
    profiles[deviceId].accountEmail = email;
    await saveJson(PROFILES_KEY, profiles);
  }

  res.json({ ok: true, token, adSoyad: acc.adSoyad, telefon: acc.telefon });
});

// --- ŞİFREMİ UNUTTUM: kayıtlı e-postaya 6 haneli kod gönderir (aynı OTP altyapısı, mevcut kodu geçersiz kılar) ---
app.post('/api/self-forgot-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === email && a.emailDogrulandi);
  // Güvenlik: e-posta kayıtlı olsun ya da olmasın aynı cevabı dönüyoruz —
  // böylece bir saldırgan hangi e-postaların sistemde kayıtlı olduğunu bu yoldan öğrenemez.
  if (acc) await selfOtpGonder(email);
  res.json({ ok: true });
});

app.post('/api/self-reset-password', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const kod = (req.body.kod || '').trim();
  const yeniSifre = req.body.yeniSifre || '';
  if (yeniSifre.length < 6) return res.status(400).json({ ok: false, error: 'Yeni şifre en az 6 karakter olmalı.' });

  const codes = await loadJson(SELF_OTP_KEY);
  const kodKaydi = codes.slice().reverse().find(c => c.email === email && !c.kullanildi);
  if (!kodKaydi) return res.status(400).json({ ok: false, error: 'Geçerli bir kod bulunamadı. Yeni kod isteyin.' });
  if (kodKaydi.denemeSayisi >= 5) return res.status(400).json({ ok: false, error: 'Çok fazla yanlış deneme. Yeni kod isteyin.' });
  if (Date.now() > kodKaydi.sonKullanma) return res.status(400).json({ ok: false, error: 'Kodun süresi dolmuş. Yeni kod isteyin.' });
  if (kod !== kodKaydi.kod) {
    kodKaydi.denemeSayisi = (kodKaydi.denemeSayisi || 0) + 1;
    await saveJson(SELF_OTP_KEY, codes);
    return res.status(400).json({ ok: false, error: 'Kod hatalı, tekrar deneyin.' });
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

async function selfAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
  const tokens = await loadJson(SELF_TOKENS_KEY, {});
  const entry = tokens[token];
  if (!entry) return res.status(401).json({ ok: false, error: 'Giriş yapmalısınız.' });
  req.selfEmail = entry.email;
  next();
}

// Hafif "ben kimim" uç noktası — sohbet gibi yerlerde sadece giriş yapan kişinin e-postasını
// öğrenmek için PHP köprüsüne (yemek kayıtları) gitmeye gerek kalmasın diye.
app.get('/api/self-whoami', selfAuthMiddleware, async (req, res) => {
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === req.selfEmail);
  res.json({ ok: true, email: req.selfEmail, adSoyad: acc ? acc.adSoyad : null });
});

// --- KENDİLİĞİNDEN ONARIM: cihaz-hesap bağlantısını (accountEmail) yeniden kurar ---
// Bu bağlantı ilk kez self-login sırasında kuruluyor; ama bu özellik eklenmeden ÖNCE giriş
// yapmış eski üyelerin cihazlarında bu alan hiç yazılmamış olabilir. Sayfa her açıldığında
// (giriş yapılmışsa) sessizce çağrılıp eksikse tamamlanır — kullanıcının tekrar giriş
// yapmasına gerek kalmaz.
app.post('/api/self-relink', selfAuthMiddleware, async (req, res) => {
  const deviceId = (req.body.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const profiles = await loadJson(PROFILES_KEY, {});
  if (!profiles[deviceId]) profiles[deviceId] = {};
  if (profiles[deviceId].accountEmail !== req.selfEmail) {
    profiles[deviceId].accountEmail = req.selfEmail;
    await saveJson(PROFILES_KEY, profiles);
  }
  res.json({ ok: true });
});

// --- KENDİ YEMEKHANE KAYITLARIM (PHP/MySQL sistemine köprü üzerinden ulaşır) ---
app.get('/api/my-meals', selfAuthMiddleware, async (req, res) => {
  const accounts = await loadJson(SELF_ACCOUNTS_KEY);
  const acc = accounts.find(a => a.email === req.selfEmail);
  if (!acc) return res.status(404).json({ ok: false, error: 'Hesap bulunamadı.' });

  // ?donem_id=17 gibi gönderilirse o dönemin kayıtları gelir; hiç gönderilmezse
  // PHP tarafı bugünün tarihine göre "içinde bulunulan dönemi" otomatik seçer.
  const donemId = req.query.donem_id || null;

  try {
    const bridgeRes = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bridge-Key': BRIDGE_SECRET },
      body: JSON.stringify({ telefon: acc.telefon, donem_id: donemId }),
    });
    const data = await bridgeRes.json();
    res.json(data);
  } catch (err) {
    console.error('Köprü API hatası:', err.message);
    res.status(502).json({ ok: false, error: 'Yemekhane sistemine şu an ulaşılamıyor, lütfen daha sonra tekrar deneyin.' });
  }
});

// --- DUYURU YORUMLARI ROTALARI ---
app.get('/api/messages/:id/comments', async (req, res) => {
  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const comments = commentsMap[req.params.id] || [];
  // E-posta adresini herkese açık cevapta göstermiyoruz — sadece "bu yorum bana mı ait" bilgisini
  // (varsa Authorization token'ından) döndürüyoruz, düzenle/sil butonlarını ona göre göstermek için.
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
    email: req.selfEmail, // sahiplik kontrolü (düzenleme/silme) için — kullanıcıya gösterilmez
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

// --- KENDİ YORUMUNU DÜZENLEME ---
app.put('/api/messages/:msgId/comments/:commentId', selfAuthMiddleware, async (req, res) => {
  const cleanText = (req.body.text || '').trim().slice(0, 180);
  if (!cleanText) return res.status(400).json({ ok: false, error: 'Yorum metni boş olamaz.' });

  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const list = commentsMap[req.params.msgId] || [];
  const comment = list.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Yorum bulunamadı.' });
  if (comment.email !== req.selfEmail) return res.status(403).json({ ok: false, error: 'Sadece kendi yorumunuzu düzenleyebilirsiniz.' });

  comment.text = cleanText;
  comment.editedAt = new Date().toISOString();
  await saveJson(COMMENTS_KEY, commentsMap);
  res.json({ ok: true, comment });
});

// --- KENDİ YORUMUNU SİLME ---
app.delete('/api/messages/:msgId/comments/:commentId', selfAuthMiddleware, async (req, res) => {
  const commentsMap = await loadJson(COMMENTS_KEY, {});
  const list = commentsMap[req.params.msgId] || [];
  const comment = list.find(c => c.id === req.params.commentId);
  if (!comment) return res.status(404).json({ ok: false, error: 'Yorum bulunamadı.' });
  if (comment.email !== req.selfEmail) return res.status(403).json({ ok: false, error: 'Sadece kendi yorumunuzu silebilirsiniz.' });

  commentsMap[req.params.msgId] = list.filter(c => c.id !== req.params.commentId);
  await saveJson(COMMENTS_KEY, commentsMap);
  res.json({ ok: true });
});

// --- Eşleşmeyen /api/* istekleri: HTML 404 sayfası yerine anlamlı JSON dön ---
// (Böylece frontend'de "Unexpected token '<' ... is not valid JSON" gibi kriptik
// hatalar yerine, hangi endpoint'in eksik/yanlış olduğu net görünür.)
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint bulunamadı: ' + req.method + ' ' + req.originalUrl });
});

// Multer/genel hataları çirkin bir stack trace sayfası yerine düzgün JSON olarak dön.
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
