# 🚀 Yerel Dedikodu — Kalıcı Yayına Alma (3 dakika)

Şu anki linkler **geçici tüneller**. Linklerin hiç ölmemesi ve `yerel-dedikodu.onrender.com` gibi
sabit bir adresin olması için aşağıdaki adımları yap. Kod tarafında **hiçbir şey değiştirmen gerekmiyor**,
hepsi hazır.

---

## Yöntem 0 — Kendi bilgisayarında tek tıkla (hesap gerekmez) ⚡ en hızlı

1. `yerel-dedikodu.zip` dosyasını indir → bir klasöre çıkart
2. Node.js kur (tek seferlik): https://nodejs.org → **LTS** → kur
3. Klasörde:
   - **Windows:** `baslat.bat` dosyasına çift tıkla
   - **Mac:** `baslat.command` dosyasına çift tıkla
   - **Linux:** `bash baslat.command`
4. Ekranda çıkan **`https://....trycloudflare.com`** linkini arkadaşlarına gönder
5. **Pencereyi kapatma** → bilgisayar açık kaldığı sürece site yayında

> Avantajı: hiçbir yere üye olmadan, 1 dakikada gerçek link.
> Dezavantajı: bilgisayarı kapatırsan site kapanır.

---

## Yöntem 1 — Render.com (ücretsiz, kredi kartı yok) ⭐ önerilen

### 1) Projeyi GitHub'a yükle
1. https://github.com/new → isim: `yerel-dedikodu` → **Private** seçebilirsin → Create repository
2. Sayfada çıkan **"uploading an existing file"** linkine tıkla
3. Bu klasördeki şu dosyaları sürükle bırak:
   `server.js`, `package.json`, `package-lock.json`, `public/` klasörü, `Dockerfile`, `render.yaml`, `README.md`
   ⚠️ `node_modules` ve `data.json` **gerekmiyor** (yükleme)
4. **Commit changes** → bitti

### 2) Render'a bağla
1. https://render.com → **Get Started** → **GitHub ile giriş yap** (ücretsiz, kart istemez)
2. Dashboard → **New +** → **Blueprint**
3. GitHub'da az önce oluşturduğun `yerel-dedikodu` reposunu seç → **Connect**
4. Render `render.yaml` dosyasını görüp her şeyi otomatik ayarlar → **Apply / Deploy**
5. 2-3 dakika bekle → üstte **`https://yerel-dedikodu-xxxx.onrender.com`** linkin hazır 🎉

> Bu link **7/24 açık** kalır (kimse girmezse uykuya dalar, ilk ziyarette ~30 sn'de uyanır).
> Bedava plan: ayda 750 saat, kart bilgisi istemez.

### 3) İsim değiştirme
Render'da **Settings → Name** kısmından `yerel-dedikodu` adını değiştirirsen linkin de değişir:
`https://<yeni-isim>.onrender.com`

---

## Yöntem 2 — Railway.app (alternatif, yine ücretsiz başlangıç)

1. https://railway.app → GitHub ile giriş
2. **New Project → Deploy from GitHub repo** → repoyu seç
3. Railway `railway.json` sayesinde otomatik ayarlanır → **Deploy**
4. **Settings → Networking → Generate Domain** → linkin hazır

---

## Yöntem 3 — Kendi bilgisayarında çalıştır (sadece test için)

```bash
cd yerel-dedikodu
npm install
npm start
# telefonda açmak için: bilgisayarla aynı Wi-Fi'de ol, http://BILGISAYAR-IP:3000
```

Aynı ağdaki arkadaşların girebilir; başka şehirden girmesi için tünel gerekir
(`bash /home/user/supervisor.sh` bunu otomatik yapar).

---

## Yayına aldıktan sonra kontrol listesi

- [ ] Site açılıyor mu? → `https://<senin-linkin>/health` → `{"ok":true,...}` görmelisin
- [ ] Telefondan gir, ad+şehir yaz → sohbet açılıyor mu?
- [ ] Bilgisayardan aynı linki aç, ikinci kullanıcı olarak gir
- [ ] Birinden mesaj yaz → diğerinde anında görünüyor mu?
- [ ] İsme tıkla → **Mesaj gönder** → özel mesaj gidiyor mu?

## Notlar / sınırlar

- **Veri kalıcılığı:** Sunucunun diski geçicidir. **Sohbet geçmişini kalıcı yapmak için `KALICI-SOHBET.md`**
  dosyasındaki Neon adımlarını uygula (3 dakika, ücretsiz, kart yok). Sonrasında mesajlar + DM'ler hiç silinmez.
- **WebSocket:** Render/Railway WebSocket'i destekler, ek ayar gerekmez.
- **Moderasyon:** Şifre/giriş yok. Herkese açık paylaşacaksan basit bir "şifre ile gir" kapısı ekleyebilirim.
- **Aynı tarayıcıda 2 sekme** aynı kullanıcı sayılır; farklı cihaz/tarayıcı = farklı kullanıcı.
