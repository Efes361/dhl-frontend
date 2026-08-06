"use strict";

/**
 * DHL M2X Depo Izleme Paneli - İstemci Tarafı Uygulama Mantığı
 * -----------------------------------------------------------
 * NOT (GÜVENLİK UYARISI): Kullanıcı adı/şifre listesi burada, tarayıcıda
 * çalışan JS içinde açık şekilde tutuluyor. Bu sadece demo/prototip
 * amaçlıdır. Gerçek bir üretim ortamında kimlik doğrulama MUTLAKA
 * sunucu tarafında (backend + hashlenmiş şifre + oturum/token) yapılmalıdır;
 * aksi halde herkes tarayıcı konsolundan tüm şifreleri okuyabilir.
 */

// ============================================================
// SABİTLER VE YAPILANDIRMA
// ============================================================

// Host (yönetici) kullanıcıları: kullanıcı adı -> { görünen ad, şifre }
const hostUsers = {
    abdullah: { name: "Abdullah Carkci", pass: "abdullah123" },
    efe:      { name: "Enver Efe Timur", pass: "efem6134" },
    yusuf:    { name: "Yusuf Gungor",    pass: "yusuf123" },
    harun:    { name: "Harun Kurt",      pass: "harun123" },
    cem:      { name: "Cem",             pass: "cem123" },
};

// Cihaz anahtarı -> ekranda gösterilecek okunabilir isim
const deviceNames = {
    tv: "Ofis TV'si",
    fan: "Havalandirma Fani",
    toaster: "Mutfak Tost Makinesi",
    coffee: "Ofis Kahve Makinesi",
};

// MQTT bağlantı ayarları
const MQTT_CONFIG = {
    host: "broker.hivemq.com",
    port: 8000,
    useSSL: false,
    // Sayfa her yenilendiğinde farklı bir client id üretilir (çakışmayı önler)
    clientId: "dhl_m2x_monitor_" + Math.random().toString(16).slice(2, 8),
    baseTopic: "lojistik",
    reconnectDelayMs: 5000,
};

const MAX_LOG_ROWS = 50;
const NOTIFICATION_VISIBLE_MS = 3000;

// Depo anahtarları (HTML'deki card-<key> / door-<key> id'leriyle eşleşir)
const DEPOT_KEYS = ["esenyurt", "gebze", "tuzla", "orhanli", "hadimkoy"];

// Otonom sensör simülasyonu ayarları (gerçek MQTT verisi gelene kadar devrede)
const SIMULATION_CONFIG = {
    tickMs: 4000,       // her kaç ms'de bir yeni değer üretilecek
    tempMin: 16, tempMax: 29,
    humMin: 28, humMax: 72,
    tempStepMax: 0.5,   // her adımda sıcaklığın değişebileceği en fazla miktar
    humStepMax: 2.5,    // her adımda nemin değişebileceği en fazla miktar
    doorOpenChance: 0.03,   // kapı bir adımda açılma olasılığı
    doorAutoCloseTicks: 2,  // kapı kaç adım sonra kendiliğinden kapansın
};

// ============================================================
// UYGULAMA DURUMU (STATE)
// ============================================================

let currentUser = null;      // { name, role } | null
let selectedDepotKey = null; // Kroki modalında açık olan deponun anahtarı
let mqttClient = null;

// Her depo için simülasyon durumu; ilgili depodan gerçek MQTT verisi
// geldiği an "live: true" yapılır ve o depo artık simüle edilmez.
const depotSimState = {};

// ============================================================
// BAŞLANGIÇ
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initMqttClient();
    initSensorSimulation();
    addAuditLog("Sistem", "Otomasyon", "DHL M2X Izleme paneli baslatildi", "log-type-logout");
});

// ============================================================
// GİRİŞ / ÇIKIŞ İŞLEMLERİ
// ============================================================

/**
 * Login formu gönderildiğinde çalışır; seçilen host kullanıcısının
 * şifresini doğrular.
 */
function handleLogin(event) {
    event.preventDefault();

    const userKey = document.getElementById("username-select").value;
    const inputPass = document.getElementById("password-input").value.trim();
    const errorEl = document.getElementById("login-error");
    const selectedUser = hostUsers[userKey];

    if (selectedUser && selectedUser.pass === inputPass) {
        currentUser = { name: selectedUser.name, role: "HOST" };
        completeLogin();
        return;
    }

    errorEl.innerText = "Hatali sifre! Lutfen tekrar deneyiniz.";
    addAuditLog(
        "GIRIS HATASI",
        selectedUser ? selectedUser.name : userKey,
        "Hatali sifre denemesi",
        "log-type-deny"
    );
}

/** Misafir (sadece izleme) girişi. */
function loginAsGuest() {
    currentUser = { name: "Guvenlik Gorevlisi", role: "GUEST" };
    completeLogin();
}

/** Giriş başarılı olduktan sonra ortak arayüz güncellemeleri. */
function completeLogin() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("login-error").innerText = "";
    document.getElementById("password-input").value = "";

    document.getElementById("active-user-name").innerText = currentUser.name;
    document.getElementById("last-login-user").innerText =
        `${currentUser.name} (${currentUser.role})`;

    const roleEl = document.getElementById("active-user-role");
    const isHost = currentUser.role === "HOST";
    roleEl.innerText = isHost ? "HOST / ADMIN" : "GUVENLIK (MISAFIR)";
    roleEl.className = `role-tag ${isHost ? "role-host" : "role-guest"}`;

    addAuditLog(
        "Giris Portali",
        `${currentUser.name} [${currentUser.role}]`,
        "Sisteme basariyla oturum acildi",
        "log-type-login"
    );
}

/** Oturumu kapatır ve login ekranına geri döner. */
function logout() {
    if (currentUser) {
        addAuditLog("Giris Portali", currentUser.name, "Oturum kapatildi", "log-type-logout");
    }
    currentUser = null;
    document.getElementById("login-overlay").style.display = "flex";
}

// ============================================================
// MQTT BAĞLANTI YÖNETİMİ
// ============================================================

/** MQTT istemcisini oluşturur, olay dinleyicilerini bağlar ve bağlanır. */
function initMqttClient() {
    mqttClient = new Paho.MQTT.Client(
        MQTT_CONFIG.host,
        Number(MQTT_CONFIG.port),
        MQTT_CONFIG.clientId
    );

    mqttClient.onMessageArrived = onMessageArrived;
    mqttClient.onConnectionLost = (response) => {
        console.warn("MQTT baglantisi koptu:", response.errorMessage);
        updateMqttStatus(false);
        setTimeout(initMqttClient, MQTT_CONFIG.reconnectDelayMs);
    };

    mqttClient.connect({
        useSSL: MQTT_CONFIG.useSSL,
        onSuccess: () => {
            updateMqttStatus(true);
            mqttClient.subscribe(`${MQTT_CONFIG.baseTopic}/#`);
            addAuditLog("MQTT Sunucusu", "Broker", "Canli veri yayin hatti kuruldu", "log-type-login");
        },
        onFailure: (err) => {
            console.error("MQTT baglanti hatasi:", err.errorMessage);
            updateMqttStatus(false);
            setTimeout(initMqttClient, MQTT_CONFIG.reconnectDelayMs);
        },
    });
}

/**
 * Gelen her MQTT mesajını işler.
 * Beklenen topic yapısı: lojistik/<depoAdi>/<olcumTuru>
 */
function onMessageArrived(message) {
    const parts = message.destinationName.split("/");
    if (parts.length < 3 || parts[0] !== MQTT_CONFIG.baseTopic) return;

    const [, depotKey, type] = parts;
    const payload = message.payloadString;

    // Bu depodan gerçek bir sensör verisi geldi; artık bu depo için
    // otonom simülasyonu durdurup gerçek veriyi esas alıyoruz.
    markDepotAsLive(depotKey);

    updateQuickUI(depotKey, type, payload);

    if (selectedDepotKey === depotKey) {
        updateModalUI(type, payload);
    }

    if (type === "door" && payload.toUpperCase() === "OPEN") {
        addAuditLog(depotKey.toUpperCase(), "Sensor Alarmi", "KAPILAR ACILDI!", "log-type-alarm");
    }
}

/** Depo kartındaki hızlı özet bilgileri (sıcaklık/nem/kapı) günceller. */
function updateQuickUI(depotKey, type, value) {
    const card = document.getElementById(`card-${depotKey}`);
    if (!card) return;

    if (type === "temp") {
        card.querySelector(".m-temp").innerText = `${value}°C`;
    } else if (type === "hum") {
        card.querySelector(".m-hum").innerText = `${value}%`;
    } else if (type === "door") {
        const doorTag = document.getElementById(`door-${depotKey}`);
        const isOpen = value.toUpperCase() === "OPEN";
        doorTag.className = `door-tag ${isOpen ? "door-open" : "door-closed"}`;
        doorTag.innerText = isOpen ? "ACIK" : "KAPALI";
    }
}

/** Kontrol komutunu ilgili cihazın "set" topic'ine yayınlar (yalnızca HOST). */
function sendControl(device, state) {
    if (!selectedDepotKey || !currentUser || currentUser.role !== "HOST") return;
    if (!mqttClient || !mqttClient.isConnected()) {
        addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, "HATA: MQTT baglantisi yok, komut gonderilemedi", "log-type-deny");
        return;
    }

    const topic = `${MQTT_CONFIG.baseTopic}/${selectedDepotKey}/${device}/set`;
    const mqttMessage = new Paho.MQTT.Message(state);
    mqttMessage.destinationName = topic;
    mqttClient.send(mqttMessage);

    const deviceLabel = deviceNames[device] || device;
    const actionText = state === "ON" ? "CALISTIRILDI (ACILDI)" : "DURDURULDU (KAPATILDI)";

    addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, `KOMUT: ${deviceLabel} -> ${actionText}`, "log-type-cmd");
    showUserNotification(currentUser.name, selectedDepotKey, device, state);
}

// ============================================================
// OTONOM SENSÖR SİMÜLASYONU (CANLI VERİ GELENE KADAR)
// ============================================================

/**
 * Her depo için başlangıç sıcaklık/nem/kapı durumunu üretir ve
 * belirli aralıklarla rastgele yürüyüş (random walk) ile güncelleyen
 * zamanlayıcıyı başlatır. Amaç, gerçek bir MQTT sensör verisi
 * bağlanmadığı sürece panelin "--" boş görünmemesi, gerçekçi ve
 * otonom şekilde canlı gibi hareket etmesidir.
 */
function initSensorSimulation() {
    DEPOT_KEYS.forEach((depotKey) => {
        depotSimState[depotKey] = {
            live: false, // true olduğunda bu depo artık simüle edilmez
            temp: randomInRange(19, 25),
            hum: randomInRange(40, 60),
            doorOpen: false,
            doorTicksLeft: 0,
        };
        // Sayfa ilk açıldığında kartlar "--" beklemeden değer göstersin
        applyDepotReading(depotKey, depotSimState[depotKey]);
    });

    setInterval(stepSimulation, SIMULATION_CONFIG.tickMs);
}

/** Tüm depoları bir adım ileri götürür (canlı veri gelenler hariç). */
function stepSimulation() {
    DEPOT_KEYS.forEach((depotKey) => {
        const state = depotSimState[depotKey];
        if (!state || state.live) return;

        state.temp = clamp(
            state.temp + randomStep(SIMULATION_CONFIG.tempStepMax),
            SIMULATION_CONFIG.tempMin,
            SIMULATION_CONFIG.tempMax
        );
        state.hum = clamp(
            state.hum + randomStep(SIMULATION_CONFIG.humStepMax),
            SIMULATION_CONFIG.humMin,
            SIMULATION_CONFIG.humMax
        );

        updateDoorSimState(depotKey, state);
        applyDepotReading(depotKey, state);
    });
}

/** Kapı durumunu olasılıksal olarak günceller; açıksa birkaç adım sonra kapatır. */
function updateDoorSimState(depotKey, state) {
    if (!state.doorOpen && Math.random() < SIMULATION_CONFIG.doorOpenChance) {
        state.doorOpen = true;
        state.doorTicksLeft = SIMULATION_CONFIG.doorAutoCloseTicks;
        addAuditLog(depotKey.toUpperCase(), "Sensor Alarmi", "KAPILAR ACILDI! (otonom simülasyon)", "log-type-alarm");
    } else if (state.doorOpen) {
        state.doorTicksLeft -= 1;
        if (state.doorTicksLeft <= 0) {
            state.doorOpen = false;
        }
    }
}

/** Üretilen değerleri gerçek MQTT mesajıymış gibi arayüze uygular. */
function applyDepotReading(depotKey, state) {
    const tempStr = state.temp.toFixed(1);
    const humStr = Math.round(state.hum).toString();
    const doorStr = state.doorOpen ? "OPEN" : "CLOSED";

    updateQuickUI(depotKey, "temp", tempStr);
    updateQuickUI(depotKey, "hum", humStr);
    updateQuickUI(depotKey, "door", doorStr);

    if (selectedDepotKey === depotKey) {
        updateModalUI("temp", tempStr);
        updateModalUI("hum", humStr);
        updateModalUI("door", doorStr);
    }
}

/** Bir depodan gerçek MQTT verisi geldiğinde o depoyu simülasyondan çıkarır. */
function markDepotAsLive(depotKey) {
    const state = depotSimState[depotKey];
    if (state && !state.live) {
        state.live = true;
        addAuditLog(depotKey.toUpperCase(), "Sistem", "Canli sensor verisi algilandi, simulasyon durduruldu", "log-type-login");
    }
}

/** min (dahil) ile max (dahil) arasında rastgele ondalıklı sayı üretir. */
function randomInRange(min, max) {
    return min + Math.random() * (max - min);
}

/** -maxStep ile +maxStep arasında rastgele bir adım büyüklüğü üretir. */
function randomStep(maxStep) {
    return (Math.random() * 2 - 1) * maxStep;
}

/** Değeri [min, max] aralığına sıkıştırır. */
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// ============================================================
// KROKİ / DETAY MODALI
// ============================================================

/** Depo kartına tıklanınca çağrılır; yetkiye göre kroki modalını açar. */
function handleDepotClick(depotKey, title) {
    if (!currentUser) return;

    const depotNameUpper = depotKey.toUpperCase();

    if (currentUser.role === "HOST") {
        addAuditLog(depotNameUpper, currentUser.name, "Depo detay krokisi ve cihaz yonetimi inceleniyor", "log-type-view");
        openDetails(depotKey, title);
    } else {
        addAuditLog(depotNameUpper, currentUser.name, "ENGEL: Kroki acma yetkisi reddedildi (Misafir Kullanici)", "log-type-deny");
        alert(
            "Guvenlik Gorevlisi Yetkisi:\n" +
            "Kroki ve uzaktan kontrol cihazlari yalnizca Host (Admin) kullanicilarin erisimine aciktir. " +
            "Sayfadan anlik Acik/Kapali durumlarini takip edebilirsiniz."
        );
    }
}

function openDetails(depotKey, title) {
    selectedDepotKey = depotKey;
    document.getElementById("modal-title").innerText = title;
    document.getElementById("details-overlay").style.display = "flex";
    resetModalValues();

    // Simüle edilen (henüz canlı MQTT verisi gelmemiş) depolar için
    // modalı açar açmaz mevcut sıcaklık/nem değerlerini göster.
    const state = depotSimState[depotKey];
    if (state && !state.live) {
        updateModalUI("temp", state.temp.toFixed(1));
        updateModalUI("hum", Math.round(state.hum).toString());
    }
}

function closeDetails() {
    if (selectedDepotKey && currentUser) {
        addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, "Kroki ekrani kapatildi", "log-type-logout");
    }
    selectedDepotKey = null;
    document.getElementById("details-overlay").style.display = "none";
}

/** Modal içindeki sensör/cihaz görünümünü gelen veriyle günceller. */
function updateModalUI(type, value) {
    const upperValue = value.toUpperCase();
    const isOn = upperValue === "ON";

    if (type === "temp") {
        document.getElementById("modal-temp").innerText = `${value} °C`;
    } else if (type === "hum") {
        document.getElementById("modal-hum").innerText = `${value} %`;
    }

    const statusText = document.getElementById(`m-status-${type}`);
    if (statusText) {
        statusText.innerText = isOn ? "ACIK" : "KAPALI";
        statusText.className = `status-text ${isOn ? "text-on" : "text-off"}`;
    }

    const svgIcon = document.getElementById(`svg-${type}`);
    if (svgIcon) {
        svgIcon.setAttribute("class", `device-icon ${isOn ? "device-on" : "device-off"}`);
    }

    if (type === "door") {
        const doorSvg = document.getElementById("svg-door-main");
        if (doorSvg) doorSvg.classList.toggle("door-open-w", upperValue === "OPEN");
    }
}

/** Modal her açıldığında değerleri varsayılan (bilinmiyor) haline sıfırlar. */
function resetModalValues() {
    ["modal-temp", "modal-hum"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerText = "--";
    });

    ["tv", "toaster", "coffee", "fan"].forEach((device) => {
        const statusEl = document.getElementById(`m-status-${device}`);
        if (statusEl) {
            statusEl.innerText = "KAPALI";
            statusEl.className = "status-text text-off";
        }
        const svg = document.getElementById(`svg-${device}`);
        if (svg) svg.setAttribute("class", "device-icon device-off");
    });

    const doorSvg = document.getElementById("svg-door-main");
    if (doorSvg) doorSvg.classList.remove("door-open-w");
}

// ============================================================
// DENETİM (AUDIT) LOGLARI
// ============================================================

/**
 * Log tablosuna yeni bir satır ekler. Değerler innerText/textContent
 * üzerinden yazılır; böylece log içeriğinde HTML/script enjeksiyonu
 * (XSS) riski oluşmaz.
 */
function addAuditLog(location, user, action, cssClass = "") {
    const tbody = document.getElementById("log-tbody");
    if (!tbody) return;

    const row = tbody.insertRow(0);
    const timeStr = new Date().toTimeString().split(" ")[0];

    const timeCell = row.insertCell();
    timeCell.innerHTML = "<strong></strong>";
    timeCell.querySelector("strong").textContent = timeStr;

    const userCell = row.insertCell();
    userCell.textContent = user;

    const locationCell = row.insertCell();
    locationCell.innerHTML = '<span class="badge-loc"></span>';
    locationCell.querySelector(".badge-loc").textContent = location;

    const actionCell = row.insertCell();
    actionCell.textContent = action;
    if (cssClass) actionCell.className = cssClass;

    while (tbody.rows.length > MAX_LOG_ROWS) {
        tbody.deleteRow(tbody.rows.length - 1);
    }
}

function clearLogs() {
    const tbody = document.getElementById("log-tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    addAuditLog("Sistem", currentUser ? currentUser.name : "Sistem", "Log gecmisi temizlendi", "log-type-logout");
}

// ============================================================
// BİLDİRİMLER
// ============================================================

/** Ekranın sağ üstünde geçici bir "cihaz açıldı/kapatıldı" bildirimi gösterir. */
function showUserNotification(user, depotKey, device, state) {
    const area = document.getElementById("notification-area");
    const depotName = depotKey.charAt(0).toUpperCase() + depotKey.slice(1);
    const deviceLabel = deviceNames[device] || device;
    const actionLabel = state === "ON" ? "ACTI" : "KAPATTI";

    const box = document.createElement("div");
    box.className = "notify-box";

    const userSpan = document.createElement("span");
    userSpan.className = "notify-user";
    userSpan.textContent = `${user} (Host)`;

    const actionSpan = document.createElement("span");
    actionSpan.className = "notify-action";
    actionSpan.textContent = actionLabel;

    box.append(
        userSpan,
        document.createTextNode(`, ${depotName} deposunda ${deviceLabel} `),
        actionSpan,
        document.createTextNode(".")
    );

    area.appendChild(box);

    // Giriş animasyonunun tetiklenmesi için bir sonraki frame'de class eklenir
    requestAnimationFrame(() => box.classList.add("show"));

    setTimeout(() => {
        box.classList.remove("show");
        setTimeout(() => box.remove(), 300);
    }, NOTIFICATION_VISIBLE_MS);
}

/** Üst banttaki MQTT bağlantı durumu rozetini günceller. */
function updateMqttStatus(isOnline) {
    const statusEl = document.getElementById("mqtt-status");
    statusEl.innerText = isOnline ? "MQTT: BAGLANDI" : "MQTT: BAGLANTI YOK";
    statusEl.style.background = isOnline ? "var(--safe-green)" : "var(--alarm-red)";
}
