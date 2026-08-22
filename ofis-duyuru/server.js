// Ofis Duyuru Sistemi - Backend
// Basit, tek dosyalık Express sunucusu. Web Push (VAPID) kullanır.
// Ücretsizdir; SMS veya WhatsApp Business API gerekmez.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Dosya ekleri (JPG/PNG/PDF) ----
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
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
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'degistir-bu-sifreyi').trim();

// Şifre karşılaştırması: baştaki/sondaki görünmez boşlukları temizler.
// Hatalıysa (şifrenin kendisini değil) sadece uzunluk bilgisini loglar — teşhis için.
function checkPassword(input) {
  const clean = (input || '').trim();
  const ok = clean === ADMIN_PASSWORD;
  if (!ok) {
    console.log(`[şifre reddedildi] gelen uzunluk=${clean.length}, beklenen uzunluk=${ADMIN_PASSWORD.length}`);
  }
  return ok;
}

// ---- VAPID anahtarları ----
// Bunlar sunucunun kimliğini push servislerine kanıtlar.
// Ortam değişkeni yoksa ilk açılışta otomatik üretir ve konsola yazar.
// Üretimde bunları .env / hosting panelinde sabitleyin (aksi halde
// her yeniden başlatmada abonelikler geçersiz olur).
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = keys.publicKey;
  VAPID_PRIVATE_KEY = keys.privateKey;
  console.log('\n=== VAPID ANAHTARLARI OTOMATİK ÜRETİLDİ ===');
  console.log('Bunları hosting panelinizde ortam değişkeni olarak kaydedin:');
  console.log('VAPID_PUBLIC_KEY=' + VAPID_PUBLIC_KEY);
  console.log('VAPID_PRIVATE_KEY=' + VAPID_PRIVATE_KEY);
  console.log('===========================================\n');
}

webpush.setVapidDetails(
  'mailto:ofis@example.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ---- Basit dosya tabanlı abonelik deposu ----
function loadSubs() {
  try {
    return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveSubs(subs) {
  fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
}

// ---- Gönderilen duyuruların geçmişi (herkes görebilir, kimlik bilgisi içermez) ----
function loadMessages() {
  try {
    return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

app.get('/api/messages', (req, res) => {
  const messages = loadMessages();
  // en yeni en üstte, en fazla son 30 duyuru
  res.json({ messages: messages.slice(-30).reverse() });
});

// Telefonun genel açık anahtarını (public key) frontend'e ver
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Personel telefonu bildirime izin verince buraya kaydolur.
// Kullanıcıdan isim İSTENMEZ (yalan yazılabilir) — sadece cihaza görünmez bir kimlik atanır.
// İsim eşleştirmesini sadece yönetici, /api/devices üzerinden yapar.
app.post('/api/subscribe', (req, res) => {
  const { deviceId, ...subscription } = req.body;
  const subs = loadSubs();
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push({ ...subscription, deviceId: deviceId || null, name: null, subscribedAt: new Date().toISOString() });
    saveSubs(subs);
  } else if (deviceId && !exists.deviceId) {
    exists.deviceId = deviceId;
    saveSubs(subs);
  }
  res.status(201).json({ ok: true, total: subs.length });
});

// Yönetici: bilinen cihazları listele (isim ataması yapmak için)
app.get('/api/devices', (req, res) => {
  const subs = loadSubs();
  const byDevice = new Map();
  for (const s of subs) {
    if (!s.deviceId) continue;
    byDevice.set(s.deviceId, { deviceId: s.deviceId, name: s.name || null, subscribedAt: s.subscribedAt || null });
  }
  res.json({ devices: Array.from(byDevice.values()).sort((a, b) => (b.subscribedAt || '').localeCompare(a.subscribedAt || '')) });
});

// Yönetici: bir cihaza gerçek isim ata (sadece bu, kullanıcı kendi giremez)
app.post('/api/devices/name', (req, res) => {
  const { password, deviceId, name } = req.body;
  if (!checkPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
  }
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const subs = loadSubs();
  let matched = false;
  for (const s of subs) {
    if (s.deviceId === deviceId) { s.name = (name || '').trim() || null; matched = true; }
  }
  saveSubs(subs);
  res.json({ ok: true, matched });
});

// Abonelikten çık (opsiyonel, ileride kullanılabilir)
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const subs = loadSubs().filter(s => s.endpoint !== endpoint);
  saveSubs(subs);
  res.json({ ok: true });
});

// Yönetici mesaj gönderir -> herkese push bildirimi gider (opsiyonel JPG/PNG/PDF ekli)
app.post('/api/send', upload.single('attachment'), async (req, res) => {
  const { password, category, title, body } = req.body;

  if (!checkPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
  }
  if (!title || !body) {
    return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });
  }

  const attachment = attachmentFromFile(req.file);
  const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const subs = loadSubs();
  const payload = JSON.stringify({
    id: messageId,
    title: `${categoryEmoji(category)} ${title}`,
    body,
    category: category || 'genel',
    urgent: category === 'acil',
    // Resimli ekler bildirim tepsisinde büyük görsel olarak görünür (Android/Chrome)
    image: attachment && attachment.type === 'image' ? attachment.url : undefined,
  });

  let sent = 0;
  let removed = 0;
  const stillValid = [];

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      // 410/404 = abonelik artık geçersiz (uygulama kaldırılmış, izin geri alınmış vb.)
      if (err.statusCode === 410 || err.statusCode === 404) {
        removed++;
      } else {
        stillValid.push(sub);
      }
    }
  }

  saveSubs(stillValid);

  // Duyuruyu geçmişe kaydet (herkesin sitede görebileceği liste)
  const messages = loadMessages();
  messages.push({
    id: messageId,
    category: category || 'genel',
    title,
    body,
    time: new Date().toISOString(),
    attachment,
    reads: [],
  });
  saveMessages(messages.slice(-100)); // en fazla son 100 kayıt tut

  res.json({ ok: true, sent, removed, totalSubscribers: stillValid.length, messageId });
});

// Duyuruyu sil (yanlış/anlamsız yazılmışsa)
app.delete('/api/messages/:id', (req, res) => {
  const { password } = req.body;
  if (!checkPassword(password)) {
    return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
  }
  const messages = loadMessages().filter(m => m.id !== req.params.id);
  saveMessages(messages);
  res.json({ ok: true });
});

// Personel duyuruyu görüntülediğinde (bildirime tıklayınca) okundu olarak işaretlenir.
// Kullanıcıdan isim alınmaz — sadece görünmez cihaz kimliği kaydedilir.
app.post('/api/messages/:id/read', (req, res) => {
  const { deviceId } = req.body;
  if (!deviceId) return res.status(400).json({ ok: false, error: 'Cihaz kimliği eksik.' });
  const messages = loadMessages();
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  if (!msg.reads) msg.reads = [];
  if (!msg.reads.some(r => r.deviceId === deviceId)) {
    msg.reads.push({ deviceId, time: new Date().toISOString() });
    saveMessages(messages);
  }
  res.json({ ok: true, reads: msg.reads.length });
});

// Bir duyuruyu kimlerin okuduğunu getir — yönetici tarafından atanmış isimlerle eşleştirilir
app.get('/api/messages/:id/reads', (req, res) => {
  const messages = loadMessages();
  const msg = messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ ok: false });
  const subs = loadSubs();
  const reads = (msg.reads || []).map(r => {
    const sub = subs.find(s => s.deviceId === r.deviceId);
    const label = (sub && sub.name) || ('Cihaz #' + (r.deviceId || '').slice(-4));
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
  res.json({ total: loadSubs().length });
});

// ==========================================================
// Notlar / Telefonlar / Aylık İşler — ortak basit CRUD sistemi
// Ekleme ve silme sadece yönetici şifresiyle olur.
// ==========================================================
function makeListApi(name, fileName) {
  const FILE = path.join(__dirname, fileName);
  function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
  }
  function save(items) { fs.writeFileSync(FILE, JSON.stringify(items, null, 2)); }

  app.get(`/api/${name}`, (req, res) => {
    res.json({ items: load().slice().reverse() });
  });

  app.post(`/api/${name}`, upload.single('attachment'), (req, res) => {
    const { password, ...fields } = req.body;
    if (!checkPassword(password)) {
      return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
    }
    const attachment = attachmentFromFile(req.file);
    const items = load();
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString(), done: false, attachment, ...fields };
    items.push(item);
    save(items.slice(-200));
    res.json({ ok: true, item });
  });

  app.delete(`/api/${name}/:id`, (req, res) => {
    const { password } = req.body;
    if (!checkPassword(password)) {
      return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
    }
    const items = load().filter(i => i.id !== req.params.id);
    save(items);
    res.json({ ok: true });
  });

  // Tamamlandı/tamamlanmadı işaretleme — herkes yapabilir, şifre gerekmez
  app.post(`/api/${name}/:id/toggle`, (req, res) => {
    const items = load();
    const item = items.find(i => i.id === req.params.id);
    if (!item) return res.status(404).json({ ok: false });
    item.done = !item.done;
    save(items);
    res.json({ ok: true, done: item.done });
  });

  return { load, save };
}

makeListApi('notes', 'notes.json');
makeListApi('phones', 'phones.json');
makeListApi('tasks', 'tasks.json');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ofis Duyuru Sistemi çalışıyor: http://localhost:${PORT}`);
});
