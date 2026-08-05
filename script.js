// KULLANICI ISIMLERI VE SIFRELERI (Ingilizce Karakterler)
const hostUsers = {
    "abdullah": { name: "Abdullah Carkci", pass: "abdullah123" },
    "efe":      { name: "Enver Efe Timur", pass: "efem6134" },
    "yusuf":    { name: "Yusuf Gungor",   pass: "yusuf123" },
    "harun":    { name: "Harun Kurt",     pass: "harun123" },
    "cem":      { name: "Cem",             pass: "cem123" }
};

// Cihaz isimleri haritasi
const deviceNames = {
    tv: "Ofis TV'si",
    fan: "Havalandirma Fani",
    toaster: "Mutfak Tost Makinesi",
    coffee: "Ofis Kahve Makinesi"
};

// OTURUM DURUMU
let currentUser = null;
let selectedDepotKey = null;

// MQTT AYARLARI
const MQTT_HOST = "broker.hivemq.com";
const MQTT_PORT = 8000;
const CLIENT_ID = "dhl_m2x_monitor_" + Math.random().toString(16).substr(2, 6);

const client = new Paho.MQTT.Client(MQTT_HOST, Number(MQTT_PORT), CLIENT_ID);

document.addEventListener("DOMContentLoaded", function() {
    initMQTT();
    addAuditLog('Sistem', 'Otomasyon', 'DHL M2X Izleme paneli baslatildi', 'log-type-logout');
});

// GIRIS ISLEMLERI
function handleLogin(event) {
    event.preventDefault();
    const userKey = document.getElementById("username-select").value;
    const inputPass = document.getElementById("password-input").value.trim();
    const errorEl = document.getElementById("login-error");

    const selectedUser = hostUsers[userKey];

    if (selectedUser && selectedUser.pass === inputPass) {
        currentUser = { name: selectedUser.name, role: 'HOST' };
        completeLogin();
    } else {
        errorEl.innerText = "Hatali sifre! Lutfen tekrar deneyiniz.";
        addAuditLog('GIRIS HATASI', selectedUser ? selectedUser.name : userKey, 'Hatali sifre denemesi', 'log-type-deny');
    }
}

function loginAsGuest() {
    currentUser = { name: "Guvenlik Gorevlisi", role: 'GUEST' };
    completeLogin();
}

function completeLogin() {
    document.getElementById("login-overlay").style.display = "none";
    document.getElementById("login-error").innerText = "";
    document.getElementById("password-input").value = "";

    document.getElementById("active-user-name").innerText = currentUser.name;
    document.getElementById("last-login-user").innerText = `${currentUser.name} (${currentUser.role})`;
    
    const roleEl = document.getElementById("active-user-role");
    
    if (currentUser.role === 'HOST') {
        roleEl.innerText = "HOST / ADMIN";
        roleEl.className = "role-tag role-host";
    } else {
        roleEl.innerText = "GUVENLIK (MISAFIR)";
        roleEl.className = "role-tag role-guest";
    }

    addAuditLog('Giris Portali', `${currentUser.name} [${currentUser.role}]`, 'Sisteme basariyla oturum acildi', 'log-type-login');
}

function logout() {
    if (currentUser) {
        addAuditLog('Giris Portali', `${currentUser.name}`, 'Oturum kapatildi', 'log-type-logout');
    }
    currentUser = null;
    document.getElementById("login-overlay").style.display = "flex";
}

// MQTT BASLATMA
function initMQTT() {
    client.onMessageArrived = onMessageArrived;
    client.onConnectionLost = (response) => {
        console.log("MQTT Baglantisi Koptu: " + response.errorMessage);
        updateMqttStatus(false);
        setTimeout(initMQTT, 5000);
    };

    client.connect({
        onSuccess: () => {
            console.log("MQTT Broker'a basariyla baglandi.");
            updateMqttStatus(true);
            client.subscribe("lojistik/#");
            addAuditLog('MQTT Sunucusu', 'Broker', 'Canli veri yayin hatti kuruldu', 'log-type-login');
        },
        onFailure: (err) => {
            console.log("MQTT Baglanti Hatasi: " + err.errorMessage);
            updateMqttStatus(false);
            setTimeout(initMQTT, 5000);
        },
        useSSL: false
    });
}

// CANLI VERI GELISI
function onMessageArrived(message) {
    const topic = message.destinationName;
    const payload = message.payloadString;
    const parts = topic.split('/');

    if (parts.length >= 3 && parts[0] === 'lojistik') {
        const depotKey = parts[1];
        const type = parts[2];

        updateQuickUI(depotKey, type, payload);
        if (selectedDepotKey === depotKey) updateModalUI(type, payload);
        
        if (type === 'door' && payload.toUpperCase() === 'OPEN') {
            addAuditLog(depotKey.toUpperCase(), 'Sensor Alarmi', '?? KAPILARI ACILDI!', 'log-type-alarm');
        }
    }
}

function updateQuickUI(key, type, val) {
    const card = document.getElementById(`card-${key}`);
    if (!card) return;

    if (type === 'temp') card.querySelector('.m-temp').innerText = `${val}�C`;
    if (type === 'hum') card.querySelector('.m-hum').innerText = `${val}%`;
    if (type === 'door') {
        const doorTag = document.getElementById(`door-${key}`);
        const isOpen = val.toUpperCase() === 'OPEN';
        doorTag.className = `door-tag ${isOpen ? 'door-open' : 'door-closed'}`;
        doorTag.innerText = isOpen ? 'ACIK' : 'KAPALI';
    }
}

function handleDepotClick(depotKey, title) {
    if (!currentUser) return;

    const depotNameUpper = depotKey.toUpperCase();

    if (currentUser.role === 'HOST') {
        addAuditLog(depotNameUpper, currentUser.name, `Depo detay krokisi ve cihaz yonetimi inceleniyor`, 'log-type-view');
        openDetails(depotKey, title);
    } else {
        addAuditLog(depotNameUpper, currentUser.name, `ENGEL: Kroki acma yetkisi reddedildi (Misafir Kullanici)`, 'log-type-deny');
        alert("??? Guvenlik Gorevlisi Yetkisi:\nKroki ve uzaktan kontrol cihazlari yalnizca Host (Admin) kullanicilarin erisimine aciktir. Sayfadan anlik Acik/Kapali durumlarini takip edebilirsiniz.");
    }
}

function openDetails(depotKey, title) {
    selectedDepotKey = depotKey;
    document.getElementById("modal-title").innerText = title;
    document.getElementById("details-overlay").style.display = "flex";
    resetModalValues();
}

function closeDetails() {
    if (selectedDepotKey) {
        addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, `Kroki ekrani kapatildi`, 'log-type-logout');
    }
    selectedDepotKey = null;
    document.getElementById("details-overlay").style.display = "none";
}

function updateModalUI(type, val) {
    const up = val.toUpperCase();
    const isON = (up === 'ON');

    if (type === 'temp') document.getElementById("modal-temp").innerText = `${val} �C`;
    if (type === 'hum') document.getElementById("modal-hum").innerText = `${val} %`;
    
    const stText = document.getElementById(`m-status-${type}`);
    if (stText) {
        stText.innerText = isON ? 'ACIK' : 'KAPALI';
        stText.className = `status-text ${isON ? 'text-on' : 'text-off'}`;
    }

    const svgIcon = document.getElementById(`svg-${type}`);
    if (svgIcon) {
        svgIcon.setAttribute('class', `device-icon ${isON ? 'device-on' : 'device-off'}`);
    }

    if (type === 'door') {
        const doorSvg = document.getElementById('svg-door-main');
        if (up === 'OPEN') doorSvg.classList.add('door-open-w'); else doorSvg.classList.remove('door-open-w');
    }
}

function resetModalValues() {
    const fields = ["modal-temp", "modal-hum"];
    fields.forEach(f => {
        const el = document.getElementById(f);
        if (el) el.innerText = "--";
    });

    const controls = ["tv", "toaster", "coffee", "fan"];
    controls.forEach(c => {
        const el = document.getElementById(`m-status-${c}`);
        if (el) { el.innerText = "KAPALI"; el.className = "status-text text-off"; }
        const svg = document.getElementById(`svg-${c}`);
        if (svg) svg.setAttribute('class', 'device-icon device-off');
    });
    
    const doorSvg = document.getElementById('svg-door-main');
    if (doorSvg) doorSvg.classList.remove('door-open-w');
}

function sendControl(device, state) {
    if (!selectedDepotKey || currentUser.role !== 'HOST') return;
    
    const topic = `lojistik/${selectedDepotKey}/${device}/set`;
    const message = new Paho.MQTT.Message(state);
    message.destinationName = topic;
    client.send(message);

    const devLabel = deviceNames[device] || device;
    const actionText = state === 'ON' ? 'CALISTIRILDI (ACILDI)' : 'DURDURULDU (KAPATILDI)';

    addAuditLog(selectedDepotKey.toUpperCase(), currentUser.name, `KOMUT: ${devLabel} -> ${actionText}`, 'log-type-cmd');
    showUserNotification(currentUser.name, selectedDepotKey, device, state);
}

function addAuditLog(location, user, action, cssClass = '') {
    const tbody = document.getElementById("log-tbody");
    if (!tbody) return;

    const row = tbody.insertRow(0);
    const timeStr = new Date().toTimeString().split(' ')[0];

    row.innerHTML = `
        <td><strong>${timeStr}</strong></td>
        <td>${user}</td>
        <td><span class="badge-loc">${location}</span></td>
        <td class="${cssClass}">${action}</td>
    `;

    if (tbody.rows.length > 50) {
        tbody.deleteRow(50);
    }
}

function clearLogs() {
    const tbody = document.getElementById("log-tbody");
    if (tbody) {
        tbody.innerHTML = '';
        addAuditLog('Sistem', currentUser ? currentUser.name : 'Sistem', 'Log gecmisi temizlendi', 'log-type-logout');
    }
}

function showUserNotification(user, depotKey, device, state) {
    const area = document.getElementById("notification-area");
    const depotName = depotKey.charAt(0).toUpperCase() + depotKey.slice(1);
    const devName = deviceNames[device] || device;
    const action = state === 'ON' ? 'ACTI' : 'KAPATTI';

    const notifyHTML = `
        <div class="notify-box">
            <span class="notify-user">${user} (Host)</span>, 
            ${depotName} deposunda ${devName} 
            <span class="notify-action">${action}</span>.
        </div>
    `;
    
    area.insertAdjacentHTML('beforeend', notifyHTML);
    const boxes = area.querySelectorAll('.notify-box');
    const box = boxes[boxes.length - 1];
    
    setTimeout(() => box.classList.add('show'), 10);

    setTimeout(() => {
        box.classList.remove('show');
        setTimeout(() => box.remove(), 300);
    }, 3000);
}

function updateMqttStatus(isOnline) {
    const st = document.getElementById("mqtt-status");
    if (isOnline) {
        st.innerText = "MQTT: BAGLANDI"; 
        st.style.background = "var(--safe-green)";
    } else {
        st.innerText = "MQTT: BAGLANTI YOK"; 
        st.style.background = "var(--alarm-red)";
    }
}