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
};

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

const SIMULATION_CONFIG = {
    tickMs: 4000,
    tempMin: 16, tempMax: 29,
    humMin: 28, humMax: 72,
    tempStepMax: 0.5,
    humStepMax: 2.5,
    doorOpenChance: 0.03,
    doorAutoCloseTicks: 2,
};

const ALARM_THRESHOLDS = {
    tempMin: 10,
    tempMax: 27,
    humMin: 20,
    humMax: 75,
};

const LOGIN_LOCKOUT_CONFIG = {
    maxAttempts: 5,
    lockoutMs: 30000,
};

const HISTORY_MAX_POINTS = 20;

// ============================================================
// UYGULAMA DURUMU (STATE)
// ============================================================

let currentUser = null;
let selectedDepotKey = null;
let mqttClient = null;
let isSimulationActive = true;

let totalPackagesProcessed = 1240; // KPI Simule Paket Sayaci

const depotSimState = {};
const depotAlarmState = {};
const depotHistory = {};

let loginFailCount = 0;
let loginLockedUntil = 0;
let historyChart = null;

// ============================================================
// BASLANGIC
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
    initMqttClient();
    initSensorSimulation();
    updateKPICards();
    addAuditLog("Sistem", "Otomasyon", "DHL M2X Izleme paneli baslatildi", "log-type-logout");
});

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

function completeLogin() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("login-error").innerText = "";
    document.getElementById("password-input").value = "";

    document.getElementById("active-user-name").innerText = currentUser.name;
    document.getElementById("last-login-user").innerText = `${currentUser.name} (${currentUser.role})`;

    const roleEl = document.getElementById("active-user-role");
    const isHost = currentUser.role === "HOST";
    roleEl.innerText = isHost ? "HOST / ADMIN" : "GUVENLIK (MISAFIR)";
    roleEl.className = `role-tag ${isHost ? "role-host" : "role-guest"}`;

    addAuditLog("Giris Portali", `${currentUser.name} [${currentUser.role}]`, "Sisteme basariyla oturum acildi", "log-type-login");
}

function logout() {
    if (currentUser) {
        addAuditLog("Giris Portali", currentUser.name, "Oturum kapatildi", "log-type-logout");
    }
    currentUser = null;
    document.getElementById("login-overlay").style.display = "flex";
}

// ============================================================
// MQTT BAGLANTI YONETIMI
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

    if (selectedDepotKey === depotKey) {
        updateModalUI(type, payload);
    }

    if (type === "door" && payload.toUpperCase() === "OPEN") {
        addAuditLog(depotKey.toUpperCase(), "Sensor Alarmi", "KAPILAR ACILDI!", "log-type-alarm");
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
        const isOpen = value.toUpperCase() === "OPEN";
        doorTag.className = `door-tag ${isOpen ? "door-open" : "door-closed"}`;
        doorTag.innerText = isOpen ? "ACIK" : "KAPALI";
    }
}

function sendControl(device, state) {
    if (!selectedDepotKey || !currentUser || currentUser.role !== "HOST") return;
    if (!deviceNames[device] || (state !== "ON" && state !== "OFF")) return;

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
// KPI METRIKLERI VE CANLI HESAPLAMALAR (A.1)
// ============================================================

function updateKPICards() {
    document.getElementById("kpi-total-packages").innerText = totalPackagesProcessed;

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

    if (validTempCount > 0) {
        document.getElementById("kpi-avg-temp").innerText = (totalTemp / validTempCount).toFixed(1) + " °C";
    }

    const alarmStatusEl = document.getElementById("kpi-alarm-status");
    const alarmCountEl = document.getElementById("kpi-alarm-count");

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

// ============================================================
// SIMULASYON KONTROL ISLEMLERI (E.3)
// ============================================================

function triggerSimEvent(type) {
    if (type === 'package') {
        totalPackagesProcessed += Math.floor(Math.random() * 5) + 1;
        updateKPICards();
        addAuditLog("Simulasyon", "Operator", "Depolara yeni paket girisi simule edildi", "log-type-cmd");
    } else if (type === 'alarm') {
        const randomDepot = DEPOT_KEYS[Math.floor(Math.random() * DEPOT_KEYS.length)];
        depotSimState[randomDepot].temp = 32.5; // Alarma dusur
        applyDepotReading(randomDepot, depotSimState[randomDepot]);
        addAuditLog(randomDepot.toUpperCase(), "Simulasyon Testi", "Yapay kritik sıcaklık alarmi tetiklendi!", "log-type-alarm");
    } else if (type === 'door') {
        const randomDepot = DEPOT_KEYS[Math.floor(Math.random() * DEPOT_KEYS.length)];
        depotSimState[randomDepot].doorOpen = !depotSimState[randomDepot].doorOpen;
        applyDepotReading(randomDepot, depotSimState[randomDepot]);
        addAuditLog(randomDepot.toUpperCase(), "Simulasyon Testi", `Kapi durumu degistirildi`, "log-type-cmd");
    } else if (type === 'toggle_sim') {
        isSimulationActive = !isSimulationActive;
        addAuditLog("Simulasyon", "Operator", `Otonom simulasyon ${isSimulationActive ? 'baslatildi' : 'durduruldu'}`, "log-type-login");
    }
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
// OTONOM SENSOR SIMULASYONU
// ============================================================

function initSensorSimulation() {
    DEPOT_KEYS.forEach((depotKey) => {
        depotSimState[depotKey] = {
            live: false,
            temp: randomInRange(19, 25),
            hum: randomInRange(40, 60),
            doorOpen: false,
            doorTicksLeft: 0,
        };
        applyDepotReading(depotKey, depotSimState[depotKey]);
        updateLiveBadge(depotKey, false);
    });

    setInterval(stepSimulation, SIMULATION_CONFIG.tickMs);
}

function stepSimulation() {
    if (!isSimulationActive) return;

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

    totalPackagesProcessed += Math.floor(Math.random() * 2);
    updateKPICards();
}

function updateDoorSimState(depotKey, state) {
    if (!state.doorOpen && Math.random() < SIMULATION_CONFIG.doorOpenChance) {
        state.doorOpen = true;
        state.doorTicksLeft = SIMULATION_CONFIG.doorAutoCloseTicks;
        addAuditLog(depotKey.toUpperCase(), "Sensor Alarmi", "KAPILAR ACILDI! (otonom simulasyon)", "log-type-alarm");
    } else if (state.doorOpen) {
        state.doorTicksLeft -= 1;
        if (state.doorTicksLeft <= 0) {
            state.doorOpen = false;
        }
    }
}

function applyDepotReading(depotKey, state) {
    const tempStr = state.temp.toFixed(1);
    const humStr = Math.round(state.hum).toString();
    const doorStr = state.doorOpen ? "OPEN" : "CLOSED";

    updateQuickUI(depotKey, "temp", tempStr);
    updateQuickUI(depotKey, "hum", humStr);
    updateQuickUI(depotKey, "door", doorStr);

    checkThresholds(depotKey, "temp", tempStr);
    checkThresholds(depotKey, "hum", humStr);
    recordHistory(depotKey, "temp", tempStr);
    recordHistory(depotKey, "hum", humStr);

    if (selectedDepotKey === depotKey) {
        updateModalUI("temp", tempStr);
        updateModalUI("hum", humStr);
        updateModalUI("door", doorStr);
    }
}

function markDepotAsLive(depotKey) {
    const state = depotSimState[depotKey];
    if (state && !state.live) {
        state.live = true;
        updateLiveBadge(depotKey, true);
        addAuditLog(depotKey.toUpperCase(), "Sistem", "Canli sensor verisi algilandi, simulasyon durduruldu", "log-type-login");
    }
}

function updateLiveBadge(depotKey, isLive) {
    const badge = document.getElementById(`badge-${depotKey}`);
    if (badge) {
        badge.innerText = isLive ? "CANLI" : "SIMULASYON";
        badge.className = `data-badge ${isLive ? "badge-live" : "badge-sim"}`;
    }
    if (selectedDepotKey === depotKey) {
        const modalBadge = document.getElementById("modal-data-badge");
        if (modalBadge) {
            modalBadge.innerText = isLive ? "CANLI VERI" : "SIMULE VERI";
            modalBadge.className = `data-badge ${isLive ? "badge-live" : "badge-sim"}`;
        }
    }
}

function randomInRange(min, max) { return min + Math.random() * (max - min); }
function randomStep(maxStep) { return (Math.random() * 2 - 1) * maxStep; }
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

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

    if (state && !state.live) {
        updateModalUI("temp", state.temp.toFixed(1));
        updateModalUI("hum", Math.round(state.hum).toString());
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
// DENETIM (AUDIT) LOGLARI VE FILTRELEME (C.2)
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
    statusEl.innerText = isOnline ? "MQTT: BAGLANDI" : "MQTT: BAGLANTI YOK";
    statusEl.style.background = isOnline ? "var(--safe-green)" : "var(--alarm-red)";
}