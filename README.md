# Yerel Dedikodu 💬

Yerel Dedikodu — TikTok/Instagram DM tarzı, **gerçek zamanlı** sohbet sitesi. Farklı cihazlardan giren herkes anında aynı sohbeti görür — ayrıca kişiye tıklayıp **özelden (DM)** yazabilirsin.

## Neler var?

- 🔴 **Canlı akış:** herkesin aynı anda gördüğü genel sohbet. İstanbul'daki biri yazar → Erzurum'daki anında görür (açık sayfa varsa 1 saniyeden kısa sürede).
- 👤 **Profil:** kullanıcı adı + şehir + emoji avatar. Akışta isme veya profile tıklayınca profil kartı açılır.
- ✉️ **Özel mesaj (DM):** profil kartındaki **"Mesaj gönder"** butonuyla veya sağdaki kişi listesindeki ✉️ ikonuyla açılır. Bu mesajları **sadece ikiniz görürsünüz**.
- 🟢 **Çevrimiçi durum:** kim açık, kim gitti (son görülme) — canlı olarak güncellenir.
- ⌨️ **"Yazıyor…" göstergesi:** hem genel sohbette hem DM'de.
- 🔔 **Okunmamış sayacı:** Mesajlar sekmesinde kırmızı badge + sekme başlığında `(3)` şeklinde.
- 📱 **Mobil uyumlu:** telefonda alt menü + tam ekran, masaüstünde 3 kolonlu TikTok düzeni.
- 💾 **Kalıcı kayıt:** `DATABASE_URL` verilirse mesajlar **PostgreSQL**'e (Neon) yazılır → sunucu yeniden başlasa, uyusa, deploy edilse de sohbetler **hiç silinmez**. Veritabanı yoksa `data.json` dosyasına yazar.
- 🔗 **Davet linki:** sol alttaki buton linki kopyalar, arkadaşına yollarsın.

## Çalıştırma

```bash
cd yerel-dedikodu
npm install        # ilk seferde
npm start          # http://localhost:3000
```

**Canlı public link:** https://apt-vacation-emma-calcium.trycloudflare.com

> Bu link Cloudflare "quick tunnel" ile açıldı; sandbox/sunucu açık kaldığı sürece herkes girebilir.
> Tünel otomatik yönetiliyor: `tunnel_manager.sh` linki `LINK.txt` dosyasına yazar, kopunca kendini yeniden başlatır.
> Kapandığında sadece şunu çalıştır: `bash /home/user/tunnel_manager.sh`

## İnternete açma (arkadaşların başka şehirden girsin)

Uygulama tek bir Node sunucusu, tek port kullanır. Seçenekler:

1. **Render / Railway / Fly.io:** repoyu yükle, `npm start` çalıştır, portu `process.env.PORT` üzerinden alır (hazır). 2 dk sürer.
2. **VPS (Ubuntu):** `npm start` + `pm2` veya `systemd`, önüne `nginx` reverse proxy (WebSocket için `proxy_set_header Upgrade $http_upgrade;` şart).
3. **Cloudflare Tunnel / ngrok:** lokalde çalıştırıp hızlıca dışarı açmak için: `ngrok http 3000`.

> Not: WebSocket kullanır; nginx/Cloudflare arkasında "WebSocket upgrade" izninin açık olması gerekir.

## Dosyalar

| Dosya | Açıklama |
|---|---|
| `server.js` | Express + Socket.IO sunucusu, kullanıcı/presence/DM yönetimi, `data.json` kaydı |
| `public/index.html` | Tüm arayüz (HTML + CSS + JS tek dosya) |
| `data.json` | Veritabanı bağlı değilken kullanılan yerel kayıt dosyası |
| `KURULUM-WINDOWS.md` | Windows'ta 7/24 yayına alma (Render) — adım adım |
| `KALICI-SOHBET.md` | Sohbet geçmişini kalıcı yapma (Neon veritabanı) — 3 dakika |

## Ortam değişkenleri

| Değişken | Açıklama |
|---|---|
| `PORT` | Sunucu portu (Render otomatik verir) |
| `DATABASE_URL` | PostgreSQL bağlantı adresi (Neon). **Varsa sohbet geçmişi kalıcıdır.** |
| `PGSSL` | `disable` yazarsan SSL kullanılmaz (yerel test için) |

Kalıcılık durumunu her zaman kontrol edebilirsin: `GET /health` → `{"storage":"postgres","persistent":true}`

## Ayarlar

`server.js` başındaki sabitler:

- `MAX_GLOBAL` – genel sohbette tutulan son mesaj sayısı (400)
- `MAX_THREAD` – her DM sohbetinde tutulan mesaj sayısı (300)
- `MAX_USERS` – saklanan kullanıcı limiti (600)
- Spam koruması: 6 saniyede en fazla 12 mesaj.

## Bilinen sınırlar

- Şifre/giriş yok; kimlik tarayıcıda (`localStorage`) tutulur — isteyen adını değiştirebilir.
- Aynı tarayıcıda iki sekme aynı kullanıcı sayılır (farklı cihaz/tarayıcı = farklı kullanıcı).
- Mesajlar silinemez/düzenlenemez; moderasyon yok. Herkese açık link paylaşacaksan bir yönetici paneli eklemek isteyebilirsin.
