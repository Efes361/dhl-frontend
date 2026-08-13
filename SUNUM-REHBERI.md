# DHL M2X Depo Paneli — Sunum Rehberi (Kod Blok Blok Anlatım)

Bu dosya, `index.html` içindeki kodu sunumda **tek tek açıp anlatman** için hazırlandı.
İyi haber: dosyanın en başında (satır 1-19) zaten kod 6 numaralı bloğa ayrılmış ve
her blok kendi içinde yorum satırlarıyla açıklanmış durumda — yani mühendis
dokümantasyonu formatı zaten mevcut. Aşağıda her bloğu sunumda hangi sırayla
açıp ne söyleyeceğini bulacaksın.

---

## BLOK 1 — Giriş (Login) Modalı
**Nerede:** `index.html` satır 46-88
**Ne işe yarar:** Sayfa açılır açılmaz görünen tam ekran giriş kutusu. İki yol var:
- **Host girişi**: Yönetici seçilir, şifre girilir → `script.js` içindeki
  `handleLogin(event)` fonksiyonu şifreyi SHA-256 ile hash'leyip karşılaştırır.
- **Misafir/Güvenlik girişi**: Şifresiz, sadece izleme modu → `loginAsGuest()`.

**Sunumda söyleyeceğin:** "Sistemde iki rol var: yetkili yönetici (Host) ve sadece
izleyebilen misafir. Şifreler düz metin değil, tarayıcıda SHA-256 ile hashlenip
öyle karşılaştırılıyor."

---

## BLOK 2 — Bildirim Alanı
**Nerede:** satır 90-95 (`<div id="notification-area">`)
**Ne işe yarar:** Bir cihaz açılıp kapandığında sağ üstte beliren küçük "toast"
bildirimlerinin konulduğu boş kutu. İçeriği tamamen `script.js` → `showUserNotification()`
ile JS tarafından dolduruluyor.

---

## BLOK 3 — Üst Bant (Header)
**Nerede:** satır 97-127
**Ne işe yarar:** Solda DHL logosu + başlık; sağda tema değiştirme, alarm testi,
alarm sesini kapatma, MQTT bağlantı durumu ve aktif kullanıcı rozeti.
**İlgili fonksiyonlar:** `toggleTheme()`, `testAlarmSound()`, `toggleAlarmMute()`, `logout()`.

---

## BLOK 4 — Ana Taslak (KPI + 5 Depo Kartı + Test Paneli)
**Nerede:** satır 129-251
Bu blok sunumun en "gösterişli" kısmı, üç alt parçaya ayır:

1. **KPI kartları** (satır 138-159): Toplam paket, aktif depo sayısı, ortalama
   sıcaklık, alarm durumu — hepsi `updateKPICards()` ile canlı güncellenir.
2. **5 Depo Kartı** (satır 169-235): Esenyurt, Gebze, Tuzla, Orhanlı, Hadımköy.
   Her kart tıklanınca `handleDepotClick(depotKey, title)` çalışır — Host ise
   detay modalını açar, Misafir ise sadece uyarı verir.
3. **Manuel Test Paneli** (satır 241-251): Gerçek ESP32/Wokwi bağlanmadan önce
   sahte paket/kapı olayı üretmek için — sadece Host'a görünür.

---

## BLOK 5 — Alt Bölüm (Audit Log + Sistem Bilgisi)
**Nerede:** satır 253-298
- Sol: **Denetim Logları** — kim, ne zaman, hangi depoda, ne yaptı (sadece Host görür).
- Sağ: **Sabit sistem bilgisi kutusu** — broker adresi, depo sayısı vb. (herkese açık).

---

## BLOK 6 — Kroki ve Kontrol Modalı (En Teknik Kısım)
**Nerede:** satır 301-415
Bir depo kartına tıklanınca açılan detay ekranı. İki yarıya ayrılır:

- **Sol (Kroki/SVG):** Kapı, fan, TV, tost makinesi, kahve makinesi ikonları —
  açık/kapalı oldukça renk değiştirir (`updateModalUI()` bunu yönetir).
- **Sağ (Kontrol Paneli):** Sıcaklık/nem canlı değeri, geçmiş grafik (Chart.js),
  ve cihazları AÇ/KAPAT eden butonlar → hepsi `sendControl(device, state)`
  fonksiyonu ile MQTT üzerinden `lojistik/{depo}/{cihaz}/set` konusuna
  komut gönderir.

### 🚪 Eklenen Kapı Kontrolü
Bu bloğa yeni bir grup ekledim: **"GİRİŞ KAPISI (UZAKTAN AÇ / KAPAT)"**.
Host artık kapıyı elle MQTT üzerinden açıp kapatabiliyor
(`sendControl('door','OPEN')` / `sendControl('door','CLOSE')`).

---

## ❓ "Kapı hangi mesafeden açılıyor?" — Önemli Not

Bu bilgi **bu üç dosyada (index.html / script.js / style.css) yok.** Bu dosyalar
sadece tarayıcıdaki panel — yani kapının son durumunu (`OPEN`/`CLOSED`) MQTT
üzerinden **gösteriyor**. Kapının hangi mesafede otomatik açılacağına karar
veren kod, ESP32/Wokwi tarafındaki **ultrasonik mesafe sensörü** kodunda
(genelde bir `.ino` dosyasında, örn. `if (distance < 10) { kapiyiAc(); }` gibi
bir satır) tanımlı olur — panelde değil.

Sunumda bunu şöyle anlatabilirsin: "Web panel kapının fiziksel açılmasına karar
vermiyor, sadece ESP32'nin MQTT ile yayınladığı durumu gösteriyor ve Host'a
manuel açma/kapatma komutu gönderme imkânı veriyor. Gerçek mesafe eşiği
donanım tarafındaki sensör koduna gömülü."

Eğer o `.ino`/Wokwi kodun elindeyse bana at, mesafe eşiğini de buraya (ve
istersen panelde bir bilgi satırı olarak) ekleyebilirim.
