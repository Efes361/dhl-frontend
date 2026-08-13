// DHL M2X - Akıllı Depo Yönetim Paneli
// MQTT ve Arayüz Kontrol Kodları

const MQTT_CONFIG = {
    host: "3cfb3fe92a4944b0857c473cc3156d76.s1.eu.hivemq.cloud",
    port: 8884, // WebSocket SSL portu
    useSSL: true,
    userName: "dhl",
    password: "dhl12345.",
    clientId: "dhl_m2x_monitor_" + Math.random().toString(16).slice(2, 8),
    baseTopic: "lojistik",
    reconnectDelayMs: 5000,
};

let mqttClient = null;

// Sayfa yüklendiğinde bağlantıyı başlat
document.addEventListener("DOMContentLoaded", () => {
    initMqttClient();
});

// MQTT İstemci Bağlantısı
function initMqttClient() {
    updateMqttStatus(false, "Bağlanıyor...");
    
    mqttClient = new Paho.MQTT.Client(
        MQTT_CONFIG.host, 
        Number(MQTT_CONFIG.port), 
        MQTT_CONFIG.clientId
    );

    mqttClient.onMessageArrived = onMessageArrived;
    mqttClient.onConnectionLost = (response) => {
        console.warn("MQTT Bağlantısı koptu:", response.errorMessage);
        updateMqttStatus(false, "Bağlantı Koptu");
        addAuditLog("Sistem", "Bağlantı", "MQTT Sunucu bağlantısı kesildi", "log-type-door");
        setTimeout(initMqttClient, MQTT_CONFIG.reconnectDelayMs);
    };

    mqttClient.connect({
        useSSL: MQTT_CONFIG.useSSL,
        userName: MQTT_CONFIG.userName,
        password: MQTT_CONFIG.password,
        onSuccess: () => {
            updateMqttStatus(true, "Bağlandı");
            mqttClient.subscribe(`${MQTT_CONFIG.baseTopic}/#`);
            addAuditLog("Sistem", "Bağlantı", "HiveMQ Cloud MQTT sunucusuna başarıyla bağlanıldı", "log-type-system");
        },
        onFailure: (err) => {
            console.error("MQTT Bağlantı hatası:", err.errorMessage);
            updateMqttStatus(false, "Bağlantı Hatası");
            addAuditLog("Sistem", "Hata", `Bağlantı başarısız: ${err.errorMessage}`, "log-type-door");
            setTimeout(initMqttClient, MQTT_CONFIG.reconnectDelayMs);
        },
    });
}

// Bağlantı Durumu Göstergesi Güncelleme
function updateMqttStatus(isConnected, statusText = "") {
    const indicator = document.getElementById("mqtt-status-indicator");
    const text = document.getElementById("mqtt-status-text");

    if (isConnected) {
        indicator.className = "status-indicator connected";
        text.innerText = statusText || "Bağlandı";
    } else {
        indicator.className = "status-indicator disconnected";
        text.innerText = statusText || "Bağlı Değil";
    }
}

// Gelen MQTT Mesajlarını İşleme
function onMessageArrived(message) {
    const topic = message.destinationName;
    const payload = message.payloadString;

    console.log(`[Gelen Mesaj] Topic: ${topic} | Payload: ${payload}`);

    // Konu Ayıştırma (lojistik/sicaklik vb.)
    const subTopic = topic.replace(`${MQTT_CONFIG.baseTopic}/`, "");

    switch (subTopic) {
        case "sicaklik":
            document.getElementById("val-temp").innerText = `${payload} °C`;
            addAuditLog("Sensör", "Sıcaklık", `Sıcaklık verisi güncellendi: ${payload} °C`, "log-type-sensor");
            break;
        case "nem":
            document.getElementById("val-humidity").innerText = `${payload} %`;
            addAuditLog("Sensör", "Nem", `Nem verisi güncellendi: ${payload} %`, "log-type-sensor");
            break;
        case "mesafe":
            document.getElementById("val-distance").innerText = `${payload} cm`;
            addAuditLog("Sensör", "Mesafe", `Doluluk mesafesi: ${payload} cm`, "log-type-sensor");
            break;
        case "kapi":
            const doorVal = payload.toUpperCase();
            document.getElementById("val-door").innerText = doorVal;
            document.getElementById("val-door-time").innerText = `Son: ${new Date().toLocaleTimeString()}`;
            addAuditLog("Güvenlik", "Kapı Durumu", `Depo kapı durumu değişti: ${doorVal}`, "log-type-door");
            break;
        case "kahve":
            updateDeviceUI("coffee", payload);
            break;
        case "fan":
            updateDeviceUI("fan", payload);
            break;
        case "aydinlatma":
            updateDeviceUI("light", payload);
            break;
        default:
            console.log("Tanımlanmayan konu:", subTopic);
    }
}

// Cihaz Durumlarını Arayüzde Güncelleme
function updateDeviceUI(deviceKey, state) {
    const isON = (state.toUpperCase() === "ON" || state === "1" || state.toUpperCase() === "AÇIK");
    const toggleElement = document.getElementById(`toggle-${deviceKey}`);
    const statusElement = document.getElementById(`status-${deviceKey}`);

    if (toggleElement) toggleElement.checked = isON;
    if (statusElement) {
        statusElement.innerText = isON ? "AÇIK" : "KAPALI";
        statusElement.className = isON ? "device-status active" : "device-status";
    }
}

// Arayüzden Komut Gönderme (Uzaktan Kontrol)
function toggleDevice(deviceKey, isChecked) {
    if (!mqttClient || !mqttClient.isConnected()) {
        alert("MQTT Sunucusuna bağlı değilsiniz!");
        document.getElementById(`toggle-${deviceKey}`).checked = !isChecked;
        return;
    }

    let topicName = "";
    if (deviceKey === "coffee") topicName = "kahve";
    else if (deviceKey === "fan") topicName = "fan";
    else if (deviceKey === "light") topicName = "aydinlatma";

    const payload = isChecked ? "ON" : "OFF";
    const fullTopic = `${MQTT_CONFIG.baseTopic}/${topicName}`;

    const message = new Paho.MQTT.Message(payload);
    message.destinationName = fullTopic;
    mqttClient.send(message);

    updateDeviceUI(deviceKey, payload);
    addAuditLog("Kullanıcı Kontrolü", deviceKey, `Komut gönderildi -> ${payload}`, "log-type-control");
}

// Log (Denetim Günlüğü) Ekleme
function addAuditLog(category, source, message, logClass = "log-type-system") {
    const logContainer = document.getElementById("audit-log-container");
    const now = new Date().toLocaleTimeString();

    const logItem = document.createElement("div");
    logItem.className = `log-item ${logClass}`;
    logItem.innerHTML = `
        <span class="log-time">[${now}] <strong>${category}</strong> (${source})</span>
        <span class="log-msg">${message}</span>
    `;

    logContainer.prepend(logItem);

    // Maksimum 30 log tut
    if (logContainer.children.length > 30) {
        logContainer.removeChild(logContainer.lastChild);
    }
}
