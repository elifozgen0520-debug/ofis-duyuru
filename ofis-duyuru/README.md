# Ofis Panosu — Ücretsiz Duyuru/Bildirim Sistemi

WhatsApp veya SMS kullanmadan, ofisteki herkesin telefonuna anlık bildirim
gönderen basit bir sistem. Acil duyuru, yemek listesi, vefat/doğum gibi
kategorilerle mesaj yazıp gönderiyorsunuz; abone olan herkesin telefonuna
push bildirimi düşüyor. Tamamen ücretsizdir (Web Push standardı, SMS
ücreti yoktur).

## Nasıl çalışır?

1. Personel, siteyi telefonunda bir kere açar ve **"Bildirimleri Aç"**
   butonuna basar.
2. Siz (yönetici) panelden kategori seçip mesaj yazar, şifrenizi girip
   gönderirsiniz.
3. Herkesin telefonuna anında bildirim düşer — uygulama kapalı olsa bile.

Android'de (Chrome) doğrudan çalışır. iPhone'da (Safari) önce siteyi
**"Ana Ekrana Ekle"** yapmaları gerekir (iOS 16.4+), sonrasında aynı
şekilde çalışır.

## Kurulum (yerelde denemek için)

```bash
npm install
npm start
```

Tarayıcıda `http://localhost:3000` açın. İlk çalıştırmada konsolda
`VAPID_PUBLIC_KEY` ve `VAPID_PRIVATE_KEY` üretilip yazdırılır — bunları
not edin, canlıya alırken ortam değişkeni olarak gireceksiniz.

## Ücretsiz canlıya alma (önerilen: Render.com)

Push bildirimlerinin telefonlara ulaşması için sitenin gerçek bir
HTTPS adresi olması şart (localhost yeterli değil). En kolay ücretsiz
seçenekler: **Render.com**, **Railway.app** veya **Glitch.com**.

### Render.com ile adımlar

1. Bu klasörü bir GitHub reposuna yükleyin (veya Render'ın "Deploy from
   folder" seçeneğini kullanın).
2. [render.com](https://render.com) üzerinde ücretsiz hesap açın →
   **New + → Web Service** → reponuzu seçin.
3. Build Command: `npm install`  |  Start Command: `npm start`
4. **Environment** sekmesinde şu değişkenleri ekleyin:
   - `ADMIN_PASSWORD` → duyuru gönderirken kullanılacak şifre
   - `VAPID_PUBLIC_KEY` → yerelde ürettiğiniz anahtar
   - `VAPID_PRIVATE_KEY` → yerelde ürettiğiniz anahtar
5. Deploy edin. Render size `https://ofis-duyuru.onrender.com` gibi bir
   adres verir. Bu adresi personelle paylaşın.

> Not: Render'ın ücretsiz planı bir süre kullanılmayınca uykuya geçer,
> ilk açılışta birkaç saniye gecikme olabilir — duyuru sistemi için
> sorun teşkil etmez.

## Güvenlik notu

- `ADMIN_PASSWORD` sadece duyuru **gönderme** işlemini korur. Daha
  kurumsal bir kullanım isterseniz (birden fazla yetkili, kullanıcı adı
  ile giriş, log kaydı) bunu ekleyebilirim.
- Abonelik listesi `subscriptions.json` dosyasında tutulur. Büyük ofisler
  (100+ kişi) için bunu bir veritabanına (örn. SQLite) taşımak daha
  sağlıklı olur.

## Özelleştirme fikirleri

- Kategori bazlı ses/titreşim farkı zaten var (Acil'de daha belirgin).
- Yeni kategori eklemek için `index.html` içindeki `.cat-btn` satırlarına
  ve `server.js` içindeki `categoryEmoji()` fonksiyonuna bir satır
  eklemeniz yeterli.
- Birden fazla yönetici/departman ayrımı, mesaj geçmişi, veya otomatik
  günlük yemek listesi hatırlatması gibi ekler istenirse kolayca
  eklenebilir.
