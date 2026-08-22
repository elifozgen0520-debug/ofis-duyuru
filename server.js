// Ofis Duyuru Sistemi - Backend
// Basit, tek dosyalık Express sunucusu. Web Push (VAPID) kullanır.
// Ücretsizdir; SMS veya WhatsApp Business API gerekmez.

const express = require('express');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SUBS_FILE = path.join(__dirname, 'subscriptions.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'degistir-bu-sifreyi';

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

// Telefonun genel açık anahtarını (public key) frontend'e ver
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Personel telefonu bildirime izin verince buraya kaydolur
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body;
  const subs = loadSubs();
  const exists = subs.some(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push(subscription);
    saveSubs(subs);
  }
  res.status(201).json({ ok: true, total: subs.length });
});

// Abonelikten çık (opsiyonel, ileride kullanılabilir)
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const subs = loadSubs().filter(s => s.endpoint !== endpoint);
  saveSubs(subs);
  res.json({ ok: true });
});

// Yönetici mesaj gönderir -> herkese push bildirimi gider
app.post('/api/send', async (req, res) => {
  const { password, category, title, body } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Şifre hatalı.' });
  }
  if (!title || !body) {
    return res.status(400).json({ ok: false, error: 'Başlık ve mesaj zorunlu.' });
  }

  const subs = loadSubs();
  const payload = JSON.stringify({
    title: `${categoryEmoji(category)} ${title}`,
    body,
    category: category || 'genel',
    urgent: category === 'acil',
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
  res.json({ ok: true, sent, removed, totalSubscribers: stillValid.length });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ofis Duyuru Sistemi çalışıyor: http://localhost:${PORT}`);
});
