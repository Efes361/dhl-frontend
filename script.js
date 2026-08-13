"use strict";

/**
 * DHL M2X Depo Izleme Paneli - İstemci Tarafı Uygulama Mantığı
 */

// ============================================================
// SABITLER VE YAPILANDIRMA
// ============================================================

const hostUsers = {
    abdullah: { name: "Abdullah Carkci", passHash: "4c4020cd2e832dab7b42f2b779ad0b0df3a14260b0688c868317c01ac30c74d1" },
    efe:      { name: "Enver Efe Timur", passHash: "ed0ade8781c97daf80d8947be3c7086cb60527a021473ce14097cacdcd61dd1c" },
    yusuf:    { name: "Yusuf Gungor",    passHash: "7772448cf067ba366d81d3133feb61e449e65e3e6d516371cb2754e329c691b4" },
    harun:    { name: "Harun Kurt",      passHash: "60a29b64b279a5e1dfdd4856ad23476186697cda860bc87f9bceaa0274deccca" },
    cem:      { name: "Cem",             passHash: "32a67e24fade79397c51fe787c1208fbaea76e67608686e2d7ba0dd11a2dce7a" },
};

const deviceNames = {
    tv: "Ofis TV'si",
    fan: "Havalandirma Fani",
    toaster: "Mutfak Tost Makinesi",
    coffee: "Ofis Kahve Makinesi",
    door: "Ana Giris Kapisi",
};

// Kapi ON/OFF degil OPEN/CLOSE komutuyla calisir (digerlerinden farkli).
const DOOR_COMMAND_STATES = ["OPEN", "CLOSE"];

const MQTT_CONFIG = {
    host: "broker.hivemq.com",
    port: 8884,
    useSSL: true,
    clientId: "dhl_m2x_monitor_" + Math.random().toString(16).slice(2, 8),
    baseTopic: "lojistik",
    reconnectDelayMs: 5000,
};

const MAX_LOG_ROWS = 50;
const NOTIFICATION_VISIBLE_MS = 3000;
const DEPOT_KEYS = ["esenyurt", "gebze", "tuzla", "orhanli", "hadimkoy"];

const ALARM_THRESHOLDS = {
    tempMin: 10,
    tempMax: 27,
    humMin: 20,
    humMax: 75,
};

// Kapi 5 dakika kesintisiz acik kalirsa alarm calsin (her acilip kapanmada degil).
const DOOR_ALARM_CONFIG = {
    thresholdMs: 5 * 60 * 1000, // 5 dakika
};

const LOGIN_LOCKOUT_CONFIG = {
    maxAttempts: 5,
    lockoutMs: 30000,
};

const HISTORY_MAX_POINTS = 20;

// Sayfa yenilendiginde oturumun acik kalmasi icin tarayici hafizasinda tutulan anahtar.
const SESSION_STORAGE_KEY = "m2x_session_user";

// ============================================================
// UYGULAMA DURUMU (STATE)
// ============================================================

let currentUser = null;
let selectedDepotKey = null;
let mqttClient = null;

let totalPackagesProcessed = 1240; // KPI Paket Sayaci

const depotSimState = {};
const depotAlarmState = {};
const depotHistory = {};
const depotDoorState = {}; // { [depotKey]: { open, timerId, alarmActive } }

let loginFailCount = 0;
let loginLockedUntil = 0;
let historyChart = null;

// Alarm sesi icin AudioContext (dosya kullanilmaz, ses tamamen kod ile uretilir)
let alarmAudioCtx = null;
let alarmSoundMuted = false;

// ============================================================
// BASLANGIC
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initMqttClient();
    initDepotState();
    updateKPICards();
    addAuditLog("Sistem", "Otomasyon", "DHL M2X Izleme paneli baslatildi", "log-type-logout");
    restoreSession();
});

// Tarayici otomatik ses oynatma kisitlamasini ilk tiklamada kaldırma
document.addEventListener("click", () => {
    if (alarmAudioCtx && alarmAudioCtx.state === "suspended") {
        alarmAudioCtx.resume();
    }
}, { once: true });

// ============================================================
// YARDIMCI: SIFRE HASH'LEME & GENEL YARDIMCILAR
// ============================================================

async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toggleTheme() {
    document.body.classList.toggle("dark-mode");
    const isDark = document.body.classList.contains("dark-mode");
    document.getElementById("theme-btn").innerText = isDark ? "☀️ Gündüz Modu" : "🌙 Gece Modu";
}

// ============================================================
// GIRIS / CIKIS ISLEMLERI
// ============================================================

async function handleLogin(event) {
    event.preventDefault();
    const errorEl = document.getElementById("login-error");

    const now = Date.now();
    if (now < loginLockedUntil) {
        const remainingSec = Math.ceil((loginLockedUntil - now) / 1000);
        errorEl.innerText = `Cok fazla hatali deneme. Lutfen ${remainingSec} saniye sonra tekrar deneyin.`;
        return;
    }

    const userKey = document.getElementById("username-select").value;
    const inputPass = document.getElementById("password-input").value.trim();
    const selectedUser = hostUsers[userKey];
    const inputHash = await sha256Hex(inputPass);

    if (selectedUser && selectedUser.passHash === inputHash) {
        loginFailCount = 0;
        currentUser = { name: selectedUser.name, role: "HOST" };
        completeLogin();
        return;
    }

    loginFailCount += 1;
    addAuditLog("GIRIS HATASI", selectedUser ? selectedUser.name : userKey, `Hatali sifre denemesi (${loginFailCount}/${LOGIN_LOCKOUT_CONFIG.maxAttempts})`, "log-type-deny");

    if (loginFailCount >= LOGIN_LOCKOUT_CONFIG.maxAttempts) {
        loginLockedUntil = Date.now() + LOGIN_LOCKOUT_CONFIG.lockoutMs;
        loginFailCount = 0;
        const lockSec = LOGIN_LOCKOUT_CONFIG.lockoutMs / 1000;
        errorEl.innerText = `Cok fazla hatali deneme! Giris ${lockSec} saniye icin kilitlendi.`;
        addAuditLog("GUVENLIK", selectedUser ? selectedUser.name : userKey, `Ust uste hatali giris nedeniyle ${lockSec} saniye kilitlendi`, "log-type-alarm");
    } else {
        errorEl.innerText = "Hatali sifre! Lutfen tekrar deneyiniz.";
    }
}

function loginAsGuest() {
    currentUser = { name: "Guvenlik Gorevlisi", role: "GUEST" };
    completeLogin();
}

function completeLogin(isRestore = false) {
    if (!isRestore) {
        getAlarmAudioCtx();
    }

    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("login-error").innerText = "";
    document.getElementById("password-input").value = "";

    document.getElementById("active-user-name").innerText = currentUser.name;
    document.getElementById("last-login-user").innerText = `${currentUser.name} (${currentUser.role})`;

    const roleEl = document.getElementById("active-user-role");
    const isHost = currentUser.role === "HOST";
    roleEl.innerText = isHost ? "HOST / ADMIN" : "GUVENLIK (MISAFIR)";
    roleEl.className = `role-tag ${isHost ? "role-host" : "role-guest"}`;

    applyRolePermissions(isHost);
    saveSession();

    if (!isRestore) {
        addAuditLog("Giris Portali", `${currentUser.name} [${currentUser.role}]`, "Sisteme basariyla oturum acildi", "log-type-login");
    }
}

function logout() {
    if (currentUser) {
        addAuditLog("Giris Portali", currentUser.name, "Oturum kapatildi", "log-type-logout");
    }
    currentUser = null;
    clearSession();
    document.getElementById("login-overlay").style.display = "flex";
}

// ============================================================
// OTURUM KALICILIGI
// ============================================================

function saveSession() {
    try {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(currentUser));
    } catch (e) {
        console.warn("Oturum kaydedilemedi:", e);
    }
}

function clearSession() {
    try {
        localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (e) {
        console.warn("Oturum temizlenemedi:", e);
    }
}

function restoreSession() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY));
    } catch (e) {
        saved = null;
    }

    if (saved && saved.name && saved.role) {
        currentUser = saved;
        completeLogin(true);
    }
}

// ============================================================
// ROL BAZLI GORUNURLUK
// ============================================================

function applyRolePermissions(isHost) {
    const auditPanel = document.getElementById("audit-log-panel");
    if (auditPanel) auditPanel.style.display = isHost ? "" : "none";

    const bottomSections = document.getElementById("bottom-sections");
    if (bottomSections) bottomSections.classList.toggle("bottom-sections-single", !isHost);

    const simPanel = document.getElementById("sim-control-panel");
    if (simPanel) simPanel.style.display = isHost ? "" : "none";
}

// ============================================================
// MQTT BAGLANTI VE KOMUT YONETIMI
// ============================================================

function initMqttClient() {
    mqttClient = new Paho.MQTT.Client(MQTT_CONFIG.host, Number(MQTT_CONFIG.port), MQTT_CONFIG.clientId);

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

function onMessageArrived(message) {
    const parts = message.destinationName.split("/");
    if (parts.length < 3 || parts[0] !== MQTT_CONFIG.baseTopic) return;

    const [, depotKey, type] = parts;
    const payload = message.payloadString;

    if (typeof payload !== "string" || payload.length > 32) return;

    markDepotAsLive(depotKey);

    updateQuickUI(depotKey, type, payload);
    checkThresholds(depotKey, type, payload);
    recordHistory(depotKey, type, payload);

    if (depotSimState[depotKey]) {
        if (type === "temp" || type === "hum") {
            const numeric = parseFloat(payload);
            if (!Number.isNaN(numeric)) depotSimState[depotKey][type] = numeric;
        } else if (type === "door") {
            depotSimState[depotKey].doorOpen = payload.toUpperCase() === "OPEN";
        }
    }

    if (selectedDepotKey === depotKey) {
        updateModalUI(type, payload);
    }

    if (type === "door") {
        handleDoorStateChange(depotKey, payload.toUpperCase() === "OPEN", "Sensor");
    }

    updateKPICards();
}

function updateQuickUI(depotKey, type, value) {
    const card = document.getElementById(`card-${depotKey}`);
    if (!card) return;

    if (type === "temp") {
        card.querySelector(".m-temp").innerText = `${value}°C`;
    } else if (type === "hum") {
        card.querySelector(".m-hum").innerText = `${value}%`;
    } else if (type === "door") {
        const doorTag = document.getElementById(`door-${depotKey}`);
        if (doorTag) {
            const isOpen = value.toUpperCase() === "OPEN";
            doorTag.className = `door-tag ${isOpen ? "door-open" : "door-closed"}`;
            doorTag.innerText = isOpen ? "ACIK" : "KAPALI";
        }
    }
}

function sendControl(device, state) {
    if (!selectedDepotKey || !currentUser || currentUser.role !== "HOST") return;
    if (!deviceNames[device]) return;

    const isDoor = device === "door";
    const validStates = isDoor ? DOOR_COMMAND_STATES : ["ON", "OFF"];
    if (!validStates.includes(state)) return;

    if (!mqttClient || !mqttClient.isConnected()) {
        addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, "HATA: MQTT baglantisi yok, komut gonderilemedi", "log-type-deny");
        return;
    }

    const topic = `${MQTT_CONFIG.baseTopic}/${selectedDepotKey}/${device}/set`;
    const mqttMessage = new Paho.MQTT.Message(state);
    mqttMessage.destinationName = topic;
    mqttClient.send(mqttMessage);

    const deviceLabel = deviceNames[device] || device;
    let actionText;
    if (isDoor) {
        actionText = state === "OPEN" ? "MANUEL OLARAK ACILDI" : "MANUEL OLARAK KAPATILDI";
    } else {
        actionText = state === "ON" ? "CALISTIRILDI (ACILDI)" : "DURDURULDU (KAPATILDI)";
    }

    addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, `KOMUT: ${deviceLabel} -> ${actionText}`, "log-type-cmd");
    showUserNotification(currentUser.name, selectedDepotKey, device, isDoor ? (state === "OPEN" ? "ON" : "OFF") : state);

    if (isDoor) {
        handleDoorStateChange(selectedDepotKey, state === "OPEN", currentUser.name + " (Manuel Komut)");
    }
}

// ============================================================
// KPI METRIKLERI VE CANLI HESAPLAMALAR
// ============================================================

function updateKPICards() {
    const pkgEl = document.getElementById("kpi-total-packages");
    if (pkgEl) pkgEl.innerText = totalPackagesProcessed;

    let totalTemp = 0;
    let validTempCount = 0;
    let totalAlarmCount = 0;

    DEPOT_KEYS.forEach(key => {
        const state = depotSimState[key];
        if (state && state.temp) {
            totalTemp += state.temp;
            validTempCount++;
        }
        const alarm = depotAlarmState[key];
        if (alarm && (alarm.tempAlarm || alarm.humAlarm)) {
            totalAlarmCount++;
        }
    });

    const avgTempEl = document.getElementById("kpi-avg-temp");
    if (avgTempEl && validTempCount > 0) {
        avgTempEl.innerText = (totalTemp / validTempCount).toFixed(1) + " °C";
    }

    const alarmStatusEl = document.getElementById("kpi-alarm-status");
    const alarmCountEl = document.getElementById("kpi-alarm-count");

    if (alarmStatusEl && alarmCountEl) {
        if (totalAlarmCount > 0) {
            alarmStatusEl.innerText = "ALARM VAR";
            alarmStatusEl.className = "kpi-value status-alarm";
            alarmCountEl.innerText = `${totalAlarmCount} Depoda Kritik Esik Asildi`;
        } else {
            alarmStatusEl.innerText = "NORMAL";
            alarmStatusEl.className = "kpi-value status-ok";
            alarmCountEl.innerText = "Tum Eşikler Güvenli";
        }
    }
}

// ============================================================
// SIMULASYON KONTROL ISLEMLERI
// ============================================================

function triggerSimEvent(type) {
    if (type === 'package') {
        totalPackagesProcessed += Math.floor(Math.random() * 5) + 1;
        updateKPICards();
        addAuditLog("Simulasyon", "Operator", "Depolara yeni paket girisi simule edildi", "log-type-cmd");
    } else if (type === 'door') {
        const randomDepot = DEPOT_KEYS[Math.floor(Math.random() * DEPOT_KEYS.length)];
        const newDoorState = !depotSimState[randomDepot].doorOpen;
        depotSimState[randomDepot].doorOpen = newDoorState;
        applyDepotReading(randomDepot, depotSimState[randomDepot]);
        handleDoorStateChange(randomDepot, newDoorState, "Simulasyon Testi");
    }
}

// ============================================================
// ALARM SESI (WEB AUDIO API SENTEZLEYICI)
// ============================================================

function getAlarmAudioCtx() {
    if (!alarmAudioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        alarmAudioCtx = new AudioCtx();
    }
    if (alarmAudioCtx.state === "suspended") {
        alarmAudioCtx.resume();
    }
    return alarmAudioCtx;
}

function playAlarmSiren(durationMs = 2200) {
    if (alarmSoundMuted) return;

    const ctx = getAlarmAudioCtx();
    if (!ctx) return;

    const now = ctx.currentTime;
    const totalSec = durationMs / 1000;

    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = "sawtooth";
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.28, now + 0.05);
    gainNode.gain.setValueAtTime(0.28, now + totalSec - 0.15);
    gainNode.gain.linearRampToValueAtTime(0, now + totalSec);

    const cycleSec = 0.5;
    const cycles = Math.ceil(totalSec / cycleSec);
    for (let i = 0; i <= cycles; i++) {
        const t = now + i * cycleSec;
        const freq = i % 2 === 0 ? 500 : 900;
        osc.frequency.linearRampToValueAtTime(freq, t + cycleSec);
    }

    osc.start(now);
    osc.stop(now + totalSec);
}

function testAlarmSound() {
    playAlarmSiren(2200);
    addAuditLog("Sistem", currentUser ? currentUser.name : "Ziyaretci", "Alarm sesi test edildi", "log-type-view");
}

function toggleAlarmMute() {
    alarmSoundMuted = !alarmSoundMuted;
    const btn = document.getElementById("btn-alarm-mute");
    if (btn) {
        btn.innerText = alarmSoundMuted ? "🔇" : "🔊";
        btn.title = alarmSoundMuted ? "Alarm Sesi Kapali (acmak icin tikla)" : "Alarm Sesi Acik (kapatmak icin tikla)";
    }
    addAuditLog(
        "Sistem",
        currentUser ? currentUser.name : "Ziyaretci",
        alarmSoundMuted ? "Alarm sesi kapatildi" : "Alarm sesi acildi",
        "log-type-view"
    );
}

// ============================================================
// KAPI ACIK KALMA SURESI TAKIBI (5 DAKIKA ESIGI)
// ============================================================

function handleDoorStateChange(depotKey, isOpen, sourceLabel) {
    if (!depotDoorState[depotKey]) {
        depotDoorState[depotKey] = { open: false, timerId: null, alarmActive: false };
    }
    const doorState = depotDoorState[depotKey];

    const wasOpen = doorState.open;
    doorState.open = isOpen;

    if (isOpen && !wasOpen) {
        addAuditLog(depotKey.toUpperCase(), sourceLabel, "Kapi acildi", "log-type-view");

        if (doorState.timerId) clearTimeout(doorState.timerId);
        doorState.timerId = setTimeout(() => {
            doorState.timerId = null;
            doorState.alarmActive = true;
            const minutes = Math.round(DOOR_ALARM_CONFIG.thresholdMs / 60000);
            addAuditLog(
                depotKey.toUpperCase(),
                "Sensor Alarmi",
                `KAPI ${minutes} DAKIKADIR ACIK! ALARM!`,
                "log-type-alarm"
            );
            playAlarmSiren();
            applyDoorAlarmClass(depotKey, true);
        }, DOOR_ALARM_CONFIG.thresholdMs);

    } else if (!isOpen && wasOpen) {
        if (doorState.timerId) {
            clearTimeout(doorState.timerId);
            doorState.timerId = null;
        }
        const wasAlarming = doorState.alarmActive;
        doorState.alarmActive = false;
        applyDoorAlarmClass(depotKey, false);

        addAuditLog(
            depotKey.toUpperCase(),
            sourceLabel,
            wasAlarming ? "Kapi kapandi (uzun sureli acik alarmi sona erdi)" : "Kapi kapandi",
            wasAlarming ? "log-type-login" : "log-type-view"
        );
    }
}

function applyDoorAlarmClass(depotKey, active) {
    const card = document.getElementById(`card-${depotKey}`);
    if (card) card.classList.toggle("card-door-alarm", active);
}

// ============================================================
// ALARM ESIK KONTROLU
// ============================================================

function checkThresholds(depotKey, type, rawValue) {
    if (type !== "temp" && type !== "hum") return;

    if (!depotAlarmState[depotKey]) {
        depotAlarmState[depotKey] = { tempAlarm: false, humAlarm: false };
    }
    const alarmState = depotAlarmState[depotKey];
    const value = parseFloat(rawValue);
    if (Number.isNaN(value)) return;

    let isAlarm = false;
    let alarmMsg = "";

    if (type === "temp") {
        isAlarm = value < ALARM_THRESHOLDS.tempMin || value > ALARM_THRESHOLDS.tempMax;
        if (isAlarm !== alarmState.tempAlarm) {
            alarmState.tempAlarm = isAlarm;
            alarmMsg = isAlarm
                ? `SICAKLIK ALARMI: ${value.toFixed(1)}°C (esik: ${ALARM_THRESHOLDS.tempMin}-${ALARM_THRESHOLDS.tempMax}°C)`
                : `Sicaklik normale dondu: ${value.toFixed(1)}°C`;
        }
    } else {
        isAlarm = value < ALARM_THRESHOLDS.humMin || value > ALARM_THRESHOLDS.humMax;
        if (isAlarm !== alarmState.humAlarm) {
            alarmState.humAlarm = isAlarm;
            alarmMsg = isAlarm
                ? `NEM ALARMI: %${Math.round(value)} (esik: %${ALARM_THRESHOLDS.humMin}-%${ALARM_THRESHOLDS.humMax})`
                : `Nem normale dondu: %${Math.round(value)}`;
        }
    }

    if (alarmMsg) {
        addAuditLog(depotKey.toUpperCase(), "Esik Alarmi", alarmMsg, isAlarm ? "log-type-alarm" : "log-type-login");
    }

    applyCardStatusClass(depotKey);
    updateKPICards();
}

function applyCardStatusClass(depotKey) {
    const card = document.getElementById(`card-${depotKey}`);
    if (!card) return;
    const alarmState = depotAlarmState[depotKey];
    const inAlarm = !!alarmState && (alarmState.tempAlarm || alarmState.humAlarm);
    card.classList.toggle("card-alarm", inAlarm);
}

// ============================================================
// GECMIS (TREND) VERISI VE GRAFIK
// ============================================================

function recordHistory(depotKey, type, rawValue) {
    if (type !== "temp" && type !== "hum") return;
    const value = parseFloat(rawValue);
    if (Number.isNaN(value)) return;

    if (!depotHistory[depotKey]) {
        depotHistory[depotKey] = { labels: [], temp: [], hum: [] };
    }
    const hist = depotHistory[depotKey];

    if (type === "temp") hist.temp.push(value);
    if (type === "hum") hist.hum.push(value);

    if (type === "temp") {
        hist.labels.push(new Date().toTimeString().split(" ")[0]);
        while (hist.labels.length > HISTORY_MAX_POINTS) {
            hist.labels.shift();
            hist.temp.shift();
        }
        while (hist.hum.length > HISTORY_MAX_POINTS) {
            hist.hum.shift();
        }
    }

    if (selectedDepotKey === depotKey) {
        renderHistoryChart(depotKey);
    }
}

function renderHistoryChart(depotKey) {
    const canvas = document.getElementById("history-chart");
    if (!canvas || typeof Chart === "undefined") return;

    const hist = depotHistory[depotKey] || { labels: [], temp: [], hum: [] };

    if (historyChart) {
        historyChart.data.labels = hist.labels;
        historyChart.data.datasets[0].data = hist.temp;
        historyChart.data.datasets[1].data = hist.hum;
        historyChart.update("none");
        return;
    }

    historyChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
            labels: hist.labels,
            datasets: [
                {
                    label: "Sicaklik (°C)",
                    data: hist.temp,
                    borderColor: "#D40511",
                    backgroundColor: "rgba(212,5,17,0.08)",
                    yAxisID: "yTemp",
                    tension: 0.3,
                    pointRadius: 0,
                },
                {
                    label: "Nem (%)",
                    data: hist.hum,
                    borderColor: "#1971c2",
                    backgroundColor: "rgba(25,113,194,0.08)",
                    yAxisID: "yHum",
                    tension: 0.3,
                    pointRadius: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            scales: {
                yTemp: { type: "linear", position: "left", title: { display: true, text: "°C" } },
                yHum: { type: "linear", position: "right", title: { display: true, text: "%" }, grid: { drawOnChartArea: false } },
                x: { ticks: { maxTicksLimit: 6 } },
            },
            plugins: {
                legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 10 } } },
            },
        },
    });
}

function destroyHistoryChart() {
    if (historyChart) {
        historyChart.destroy();
        historyChart = null;
    }
}

// ============================================================
// DEPO DURUMU BASLATMA
// ============================================================

function initDepotState() {
    DEPOT_KEYS.forEach((depotKey) => {
        depotSimState[depotKey] = {
            live: false,
            temp: null,
            hum: null,
            doorOpen: false,
        };
        updateLiveBadge(depotKey, false);
    });
}

function applyDepotReading(depotKey, state) {
    const doorStr = state.doorOpen ? "OPEN" : "CLOSED";
    updateQuickUI(depotKey, "door", doorStr);
    if (selectedDepotKey === depotKey) {
        updateModalUI("door", doorStr);
    }

    if (typeof state.temp === "number") {
        const tempStr = state.temp.toFixed(1);
        updateQuickUI(depotKey, "temp", tempStr);
        checkThresholds(depotKey, "temp", tempStr);
        recordHistory(depotKey, "temp", tempStr);
        if (selectedDepotKey === depotKey) updateModalUI("temp", tempStr);
    }

    if (typeof state.hum === "number") {
        const humStr = Math.round(state.hum).toString();
        updateQuickUI(depotKey, "hum", humStr);
        checkThresholds(depotKey, "hum", humStr);
        recordHistory(depotKey, "hum", humStr);
        if (selectedDepotKey === depotKey) updateModalUI("hum", humStr);
    }
}

function markDepotAsLive(depotKey) {
    const state = depotSimState[depotKey];
    if (state && !state.live) {
        state.live = true;
        updateLiveBadge(depotKey, true);
        addAuditLog(depotKey.toUpperCase(), "Sistem", "Canli ESP32/Wokwi sensor verisi algilandi", "log-type-login");
    }
}

function updateLiveBadge(depotKey, isLive) {
    const badge = document.getElementById(`badge-${depotKey}`);
    if (badge) {
        badge.innerText = isLive ? "CANLI" : "VERI BEKLENIYOR";
        badge.className = `data-badge ${isLive ? "badge-live" : "badge-sim"}`;
    }
    if (selectedDepotKey === depotKey) {
        const modalBadge = document.getElementById("modal-data-badge");
        if (modalBadge) {
            modalBadge.innerText = isLive ? "CANLI VERI" : "VERI BEKLENIYOR";
            modalBadge.className = `data-badge ${isLive ? "badge-live" : "badge-sim"}`;
        }
    }
}

// ============================================================
// KROKI / DETAY MODALI
// ============================================================

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

    const state = depotSimState[depotKey];
    updateLiveBadge(depotKey, !!(state && state.live));

    if (state && state.live) {
        if (typeof state.temp === "number") updateModalUI("temp", state.temp.toFixed(1));
        if (typeof state.hum === "number") updateModalUI("hum", Math.round(state.hum).toString());
    }

    renderHistoryChart(depotKey);
}

function closeDetails() {
    if (selectedDepotKey && currentUser) {
        addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, "Kroki ekrani kapatildi", "log-type-logout");
    }
    selectedDepotKey = null;
    document.getElementById("details-overlay").style.display = "none";
    destroyHistoryChart();
}

function updateModalUI(type, value) {
    const upperValue = value.toUpperCase();
    const isOn = type === "door" ? upperValue === "OPEN" : upperValue === "ON";

    if (type === "temp") {
        const tempEl = document.getElementById("modal-temp");
        if (tempEl) tempEl.innerText = `${value} °C`;
    } else if (type === "hum") {
        const humEl = document.getElementById("modal-hum");
        if (humEl) humEl.innerText = `${value} %`;
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

function resetModalValues() {
    ["modal-temp", "modal-hum"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerText = "--";
    });

    ["tv", "toaster", "coffee", "fan", "door"].forEach((device) => {
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
// DENETIM (AUDIT) LOGLARI VE FILTRELEME
// ============================================================

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

function filterLogs() {
    const query = document.getElementById("log-search").value.toLowerCase();
    const rows = document.querySelectorAll("#log-tbody tr");

    rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? "" : "none";
    });
}

function clearLogs() {
    const tbody = document.getElementById("log-tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    addAuditLog("Sistem", currentUser ? currentUser.name : "Sistem", "Log gecmisi temizlendi", "log-type-logout");
}

function exportLogsToCsv() {
    const tbody = document.getElementById("log-tbody");
    if (!tbody || tbody.rows.length === 0) {
        alert("Disa aktarilacak log kaydi yok.");
        return;
    }

    const header = ["Saat", "Kullanici/Rol", "Depo/Konum", "Islem/Etkinlik"];
    const csvRows = [header.join(";")];

    Array.from(tbody.rows).forEach((row) => {
        const cells = Array.from(row.cells).map((cell) => {
            const text = cell.textContent.replace(/"/g, '""');
            return `"${text}"`;
        });
        csvRows.push(cells.join(";"));
    });

    const csvContent = "\uFEFF" + csvRows.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    link.href = url;
    link.download = `dhl-m2x-audit-log-${timestamp}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    addAuditLog("Sistem", currentUser ? currentUser.name : "Sistem", "Audit log CSV olarak disa aktarildi", "log-type-view");
}

// ============================================================
// BILDIRIMLER
// ============================================================

function showUserNotification(user, depotKey, device, state) {
    const area = document.getElementById("notification-area");
    if (!area) return;

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

    requestAnimationFrame(() => box.classList.add("show"));

    setTimeout(() => {
        box.classList.remove("show");
        setTimeout(() => box.remove(), 300);
    }, NOTIFICATION_VISIBLE_MS);
}

function updateMqttStatus(isOnline) {
    const statusEl = document.getElementById("mqtt-status");
    if (statusEl) {
        statusEl.innerText = isOnline ? "MQTT: BAGLANDI" : "MQTT: BAGLANTI YOK";
        statusEl.style.background = isOnline ? "var(--safe-green)" : "var(--alarm-red)";
    }
}