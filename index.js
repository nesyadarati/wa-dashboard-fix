require("dotenv").config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const fs = require("fs-extra");
const path = require("path");
const moment = require("moment");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const { exec } = require("child_process");

const STATUS_FILE = path.join(__dirname, "status.json");
const STATS_FILE = path.join(__dirname, "stats.json");
const MEDIA_DB_FILE = path.join(__dirname, "media-db.json");
const FAILED_FILE = path.join(__dirname, "failed-media.json");
const PROCESSED_FILE = path.join(__dirname, "processed.json");
const IGNORED_FILE = path.join(__dirname, "ignored-groups.json");

let sock;
global.muteTelegramAlertsUntil = null;


// ==========================================
// HELPER FUNCTIONS
// ==========================================

function saveStatus(data) {
    fs.writeJsonSync(STATUS_FILE, {
        ...data,
        updated: moment().format("YYYY-MM-DD HH:mm:ss")
    }, { spaces: 2 });
}

function updateStats(success = true) {
    let stats = { saved: 0, failed: 0 };
    if (fs.existsSync(STATS_FILE)) {
        try { stats = fs.readJsonSync(STATS_FILE); } catch {}
    }
    if (success) stats.saved++; else stats.failed++;
    fs.writeJsonSync(STATS_FILE, stats, { spaces: 2 });
}

function loadStats() {
    try { return fs.readJsonSync(STATS_FILE); } catch { return { saved: 0, failed: 0 }; }
}

function saveFailed(data) {
    let failed = [];
    if (fs.existsSync(FAILED_FILE)) {
        try { failed = fs.readJsonSync(FAILED_FILE); } catch {}
    }
    failed.unshift(data);
    if (failed.length > 1000) failed = failed.slice(0, 1000);
    fs.writeJsonSync(FAILED_FILE, failed, { spaces: 2 });
}

function saveMediaDB(data) {
    let db = [];
    try {
        if (fs.existsSync(MEDIA_DB_FILE)) {
            db = fs.readJsonSync(MEDIA_DB_FILE);
        }
    } catch {}
    db.push(data);
    fs.writeJsonSync(MEDIA_DB_FILE, db, { spaces: 2 });
}


function sanitize(str) {
    return String(str || "").replace(/[<>:"/\\|?*]/g, "_");
}

function getWeekFolder(dateMoment) {
    const day = dateMoment.date();
    const week = Math.ceil(day / 7);
    const startDay = ((week - 1) * 7) + 1;
    const endDay = Math.min(week * 7, dateMoment.daysInMonth());
    return "Week-" + week + " (" + String(startDay).padStart(2, "0") + "-" + String(endDay).padStart(2, "0") + ")";
}

function isProcessed(id) {
    try {
        if (!fs.existsSync(PROCESSED_FILE)) return false;
        const data = fs.readJsonSync(PROCESSED_FILE);
        return data.includes(id);
    } catch { return false; }
}

function markProcessed(messageId) {
    let data = [];
    try {
        if (fs.existsSync(PROCESSED_FILE)) data = fs.readJsonSync(PROCESSED_FILE);
    } catch {}
    if (!data.includes(messageId)) data.push(messageId);
    fs.writeJsonSync(PROCESSED_FILE, data, { spaces: 2 });
}


// ==========================================
// BLACKLIST / WHITELIST GRUP
// ==========================================

function loadIgnoredGroups() {
    try { return fs.readJsonSync(IGNORED_FILE); } catch { return []; }
}

function saveIgnoredGroups(groups) {
    fs.writeJsonSync(IGNORED_FILE, groups, { spaces: 2 });
}

function isGroupIgnored(groupName) {
    const ignored = loadIgnoredGroups();
    return ignored.includes(groupName);
}


// ==========================================
// CHAT LOGGER
// ==========================================

async function writeChatLog(groupName, logData) {
    try {
        const logDir = path.join(__dirname, "WA-MEDIA", groupName);
        await fs.ensureDir(logDir);
        const logFile = path.join(logDir, "chat_history.jsonl");
        await fs.appendFile(logFile, JSON.stringify(logData) + String.fromCharCode(10), "utf8");
    } catch (err) {
        console.log("GAGAL MENULIS CHAT LOG:", err.message);
    }
}

// ==========================================
// TELEGRAM MESSAGING (FORMAT RAPIH)
// ==========================================

async function sendTelegram(text) {
    try {
        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendMessage", {
            chat_id: process.env.CHAT_ID,
            text,
            parse_mode: "Markdown"
        });
    } catch (err) { console.log("TELEGRAM SEND ERROR", err.message); }
}

async function replyTelegram(chatId, text) {
    try {
        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendMessage", {
            chat_id: chatId,
            text,
            parse_mode: "Markdown"
        });
    } catch (err) { console.log(err.message); }
}


// ==========================================
// FORMAT NOTIFIKASI TELEGRAM (RAPIH)
// ==========================================

function formatMediaNotification(data) {
    const typeEmoji = { images: "🖼", videos: "🎬", documents: "📎" };
    const emoji = typeEmoji[data.type] || "📁";

    let msg = "";
    msg += "━━━━━━━━━━━━━━━━━━━━" + String.fromCharCode(10);
    msg += emoji + " *MEDIA BARU TERSIMPAN*" + String.fromCharCode(10);
    msg += "━━━━━━━━━━━━━━━━━━━━" + String.fromCharCode(10);
    msg += String.fromCharCode(10);
    msg += "👥 *Grup :* " + data.group + String.fromCharCode(10);
    msg += "👤 *Pengirim :* " + data.sender + String.fromCharCode(10);
    msg += "📱 *Nomor :* `" + data.number + "`" + String.fromCharCode(10);
    msg += "📂 *Tipe :* " + data.type.toUpperCase() + String.fromCharCode(10);
    msg += String.fromCharCode(10);
    msg += "📄 `" + data.fileName + "`" + String.fromCharCode(10);
    msg += "📅 " + data.time + String.fromCharCode(10);
    msg += "━━━━━━━━━━━━━━━━━━━━";

    return msg;
}

function formatFailedNotification(data) {
    let msg = "";
    msg += "━━━━━━━━━━━━━━━━━━━━" + String.fromCharCode(10);
    msg += "🚨 *MEDIA GAGAL DIUNDUH*" + String.fromCharCode(10);
    msg += "━━━━━━━━━━━━━━━━━━━━" + String.fromCharCode(10);
    msg += String.fromCharCode(10);
    msg += "👥 *Grup :* " + data.group + String.fromCharCode(10);
    msg += "👤 *Pengirim :* " + data.sender + String.fromCharCode(10);
    msg += "📂 *Tipe :* " + data.type + String.fromCharCode(10);
    msg += "❌ *Error :* `" + data.error + "`" + String.fromCharCode(10);
    msg += String.fromCharCode(10);
    msg += "🔑 MsgID: `" + data.messageId + "`" + String.fromCharCode(10);
    msg += "━━━━━━━━━━━━━━━━━━━━";

    return msg;
}


// ==========================================
// DAILY SUMMARY REPORT (JAM 23:00)
// ==========================================

function scheduleDailySummary() {
    setInterval(function() {
        const now = new Date();
        // Kirim jam 23:00 tepat (cek setiap menit)
        if (now.getHours() === 23 && now.getMinutes() === 0) {
            sendDailySummary();
        }
    }, 60000); // cek setiap 60 detik
}

async function sendDailySummary() {
    try {
        const stats = loadStats();
        const today = moment().format("YYYY-MM-DD");

        let db = [];
        try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        const todayMedia = db.filter(function(x) { return x.time && x.time.startsWith(today); });

        const todayImages = todayMedia.filter(function(x) { return x.type === "images"; }).length;
        const todayVideos = todayMedia.filter(function(x) { return x.type === "videos"; }).length;
        const todayDocs = todayMedia.filter(function(x) { return x.type === "documents"; }).length;
        const todayTotal = todayMedia.length;

        let failed = [];
        try { failed = fs.readJsonSync(FAILED_FILE); } catch {}
        const todayFailed = failed.filter(function(x) { return x.time && x.time.startsWith(today); }).length;

        // Hitung ukuran storage
        let storageGB = "N/A";
        try {
            const mediaDir = path.join(__dirname, "WA-MEDIA");
            if (fs.existsSync(mediaDir)) {
                let totalSize = 0;
                function walkSize(dir) {
                    const items = fs.readdirSync(dir);
                    items.forEach(function(item) {
                        const full = path.join(dir, item);
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) walkSize(full);
                        else totalSize += stat.size;
                    });
                }
                walkSize(mediaDir);
                storageGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
            }
        } catch {}

        // Top 3 grup hari ini
        const grupCount = {};
        todayMedia.forEach(function(x) {
            grupCount[x.group] = (grupCount[x.group] || 0) + 1;
        });
        const topGrups = Object.entries(grupCount)
            .sort(function(a, b) { return b[1] - a[1]; })
            .slice(0, 3);


        let NL = String.fromCharCode(10);
        let msg = "";
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📊 *LAPORAN HARIAN*" + NL;
        msg += "📅 " + today + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += NL;
        msg += "📥 *Media Masuk Hari Ini:* " + todayTotal + NL;
        msg += "   🖼 Gambar: " + todayImages + NL;
        msg += "   🎬 Video: " + todayVideos + NL;
        msg += "   📎 Dokumen: " + todayDocs + NL;
        msg += NL;
        msg += "❌ *Gagal Hari Ini:* " + todayFailed + NL;
        msg += "💾 *Storage:* " + storageGB + " GB" + NL;
        msg += NL;
        msg += "📈 *Total Keseluruhan:*" + NL;
        msg += "   Tersimpan: " + stats.saved + NL;
        msg += "   Gagal: " + stats.failed + NL;
        msg += NL;

        if (topGrups.length > 0) {
            msg += "🏆 *Top Grup Hari Ini:*" + NL;
            topGrups.forEach(function(item, idx) {
                var medal = ["🥇", "🥈", "🥉"][idx] || "▪️";
                msg += "   " + medal + " " + item[0] + " (" + item[1] + " file)" + NL;
            });
            msg += NL;
        }

        msg += "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "🤖 _Auto-generated daily report_";

        await sendTelegram(msg);
        console.log("Daily summary sent to Telegram");
    } catch (err) {
        console.log("Failed to send daily summary:", err.message);
    }
}


// ==========================================
// MAIN WA BOT
// ==========================================

async function start() {
    console.log("TOKEN :", process.env.BOT_TOKEN);
    console.log("CHAT  :", process.env.CHAT_ID);

    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: true,
        markOnlineOnConnect: false,
        browser: ["Windows", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async ({ qr, connection, lastDisconnect }) => {
        if (qr) {
            qrcode.generate(qr, { small: true });
            saveStatus({ connected: false, qr: qr });
        }
        if (connection === "open") {
            saveStatus({ connected: true, qr: null });
            console.log("CONNECTED");
            await sendMainMenuTelegram();
        }
        if (connection === "close") {
            saveStatus({ connected: false });
            console.log("CONNECTION CLOSED");

            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("RECONNECTING IN 5 SECONDS...");
                setTimeout(function() { start(); }, 5000);
            }
        }
    });


    sock.ev.on("messages.upsert", async ({ messages, type: upsertType }) => {
        let msg = null;
        let groupName = "Unknown";
        let type = "Unknown";
        let senderNumber = "unknown";
        try {
            msg = messages[0];
            if (!msg?.message) return;
            if (isProcessed(msg.key.id)) return;
            if (upsertType !== "notify" && upsertType !== "append") return;

            const jid = msg.key.remoteJid;
            if (!jid || !jid.endsWith("@g.us")) return;

            const metadata = await sock.groupMetadata(jid);
            const msgTime = moment.unix(Number(msg.messageTimestamp));
            groupName = sanitize(metadata.subject);

            senderNumber = (msg.key.participantAlt || msg.key.participant || "unknown").split("@")[0];
            const senderName = msg.pushName || "Unknown";

            // Anti-delete detection
            if (msg.message.protocolMessage && msg.message.protocolMessage.type === 3) {
                const targetDeletedId = msg.message.protocolMessage.key.id;
                let NL = String.fromCharCode(10);
                let delMsg = "━━━━━━━━━━━━━━━━━━━━" + NL;
                delMsg += "🗑 *PESAN DITARIK / DIHAPUS*" + NL;
                delMsg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
                delMsg += "👥 *Grup :* " + groupName + NL;
                delMsg += "👤 *Pengirim :* " + senderName + NL;
                delMsg += "🔑 *ID Pesan :* `" + targetDeletedId + "`" + NL;
                delMsg += "━━━━━━━━━━━━━━━━━━━━";
                await sendTelegram(delMsg);
                return;
            }


            // Log chat text
            const textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption || 
                                msg.message.videoMessage?.caption || "";

            if (textMessage.trim()) {
                await writeChatLog(groupName, {
                    id: msg.key.id,
                    time: msgTime.format("YYYY-MM-DD HH:mm:ss"),
                    sender: senderName,
                    number: senderNumber,
                    message: textMessage.trim()
                });
            }

            // Detect media type
            let isMedia = false;
            let ext = null;
            if (msg.message.imageMessage) { type = "images"; ext = "jpg"; isMedia = true; }
            else if (msg.message.videoMessage) { type = "videos"; ext = "mp4"; isMedia = true; }
            else if (msg.message.documentMessage) {
                type = "documents";
                const originalName = msg.message.documentMessage.fileName || "";
                ext = originalName.includes(".") ? originalName.split(".").pop() : "bin";
                isMedia = true;
            }

            if (!isMedia) return;

            // CHECK BLACKLIST - skip if group is ignored
            if (isGroupIgnored(groupName)) {
                console.log("SKIPPED (blacklist):", groupName);
                return;
            }


            // Build save path
            const year = msgTime.format("YYYY");
            const month = msgTime.format("YYYY-MM");
            const week = getWeekFolder(msgTime);

            const saveDir = path.join(__dirname, "WA-MEDIA", groupName, year, month, week, type);
            await fs.ensureDir(saveDir);

            // Download media
            const buffer = await downloadMediaMessage(msg, "buffer", {}, {});
            if (!buffer) throw new Error("Gagal mengunduh media dari server WA.");

            // Build filename
            let fileName;
            if (type === "documents" && msg.message.documentMessage?.fileName) {
                fileName = msgTime.format("YYYYMMDD_HHmmss") + "_" + senderNumber + "_" + sanitize(msg.message.documentMessage.fileName);
            } else {
                fileName = msgTime.format("YYYYMMDD_HHmmss") + "_" + senderNumber + "." + ext;
            }

            const filePath = path.join(saveDir, fileName);
            await fs.writeFile(filePath, buffer);

            updateStats(true);
            saveMediaDB({
                time: moment().format("YYYY-MM-DD HH:mm:ss"),
                group: groupName,
                sender: senderName,
                number: senderNumber,
                type: type,
                file: fileName,
                path: filePath,
                messageId: msg.key.id
            });

            markProcessed(msg.key.id);
            
            // KIRIM NOTIFIKASI FORMAT RAPIH
            const notifMsg = formatMediaNotification({
                group: groupName,
                sender: senderName,
                number: senderNumber,
                type: type,
                fileName: fileName,
                time: msgTime.format("YYYY-MM-DD HH:mm:ss")
            });
            await sendTelegram(notifMsg);


        } catch (err) {
            updateStats(false);
            const failedData = {
                time: moment().format("YYYY-MM-DD HH:mm:ss"),
                group: groupName,
                sender: msg?.pushName || "Unknown",
                number: senderNumber,
                type: type,
                messageId: msg?.key?.id || "",
                error: err.message || String(err)
            };
            saveFailed(failedData);

            const now = Date.now();
            if (!global.muteTelegramAlertsUntil || now > global.muteTelegramAlertsUntil) {
                let failedList = []; try { failedList = fs.readJsonSync(FAILED_FILE); } catch {}
                const recentSpamBurst = failedList.slice(0, 5).filter(function(x) {
                    return (Date.now() - moment(x.time, "YYYY-MM-DD HH:mm:ss").valueOf()) < 10000;
                }).length;
                
                if (recentSpamBurst >= 4) {
                    global.muteTelegramAlertsUntil = now + 60000; 
                    await sendTelegram("🚨 *RATE-LIMIT PROTECTION*" + String.fromCharCode(10) + "Error beruntun terdeteksi. Notifikasi di-mute 60 detik.");
                } else {
                    const failNotif = formatFailedNotification(failedData);
                    await sendTelegram(failNotif);
                }
            }
        }
    });
}


// ==========================================
// TELEGRAM INLINE MENU & COMMANDS
// ==========================================

async function sendMainMenuTelegram() {
    try {
        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendMessage", {
            chat_id: process.env.CHAT_ID,
            text: "📱 *WA Media Bot - Connected*",
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📊 Stats", callback_data: "/stats" }, { text: "🟢 Status", callback_data: "/status" }],
                    [{ text: "🛠 Services", callback_data: "/services" }, { text: "🔌 Reconnect", callback_data: "/reconnect" }],
                    [{ text: "📈 7D Chart", callback_data: "/chart" }, { text: "🚨 Logs Error", callback_data: "/viewlogs" }],
                    [{ text: "📋 Health", callback_data: "/health" }, { text: "📊 Summary", callback_data: "/summary_now" }],
                    [{ text: "🚫 Blacklist", callback_data: "/blacklist" }]
                ]
            }
        });
    } catch (e) { console.log("Gagal kirim menu:", e.message); }
}

let lastUpdateId = 0;
async function telegramCommands() {
    try {
        const res = await axios.get("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/getUpdates", {
            params: { offset: lastUpdateId + 1, timeout: 2 }
        });
        const updates = res.data.result || [];
        for (const update of updates) {
            lastUpdateId = update.update_id;
            
            const message = update.message || update.callback_query?.message;
            const text = update.message?.text || update.callback_query?.data || "";
            const chatId = message?.chat?.id;
            
            if (String(chatId) !== String(process.env.CHAT_ID)) continue;
            await handleCommand(text, chatId);
        }
    } catch (err) {
        console.log("TELEGRAM POLLING ERROR", err.message);
    }
}


async function handleCommand(text, chatId) {
    var NL = String.fromCharCode(10);

    if (text === "/status") {
        let stats = loadStats();
        let status = { connected: false }; try { status = fs.readJsonSync(STATUS_FILE); } catch {}
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += (status.connected ? "🟢" : "🔴") + " *STATUS: " + (status.connected ? "ONLINE" : "OFFLINE") + "*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "📥 Saved : " + stats.saved + NL;
        msg += "❌ Failed : " + stats.failed + NL;
        msg += "⏱ Updated : " + (status.updated || "-") + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    if (text === "/stats") {
        let stats = loadStats(); let db = []; try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📊 *STATISTIK DATA*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "🖼 Images : " + db.filter(function(x){return x.type==="images";}).length + NL;
        msg += "🎬 Videos : " + db.filter(function(x){return x.type==="videos";}).length + NL;
        msg += "📎 Documents : " + db.filter(function(x){return x.type==="documents";}).length + NL;
        msg += "📦 Total : " + db.length + NL;
        msg += NL + "────────────" + NL;
        msg += "📥 Saved : " + stats.saved + NL;
        msg += "❌ Failed : " + stats.failed + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    if (text === "/summary_now") {
        await sendDailySummary();
        return replyTelegram(chatId, "✅ Summary report dikirim.");
    }


    if (text === "/chart") {
        let db = []; try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📈 *AKTIVITAS 7 HARI*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        for (let i = 6; i >= 0; i--) {
            const dayStr = moment().subtract(i, "days").format("YYYY-MM-DD");
            const total = db.filter(function(x){return x.time && x.time.startsWith(dayStr);}).length;
            const bar = "▇".repeat(Math.min(total, 15)) || "▪";
            msg += moment(dayStr).format("ddd DD") + " | " + bar + " " + total + NL;
        }
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    if (text === "/viewlogs") {
        try {
            if (!fs.existsSync(FAILED_FILE)) return replyTelegram(chatId, "✅ Tidak ada log error.");
            const failedList = fs.readJsonSync(FAILED_FILE);
            if (!failedList || failedList.length === 0) return replyTelegram(chatId, "✅ Log error kosong.");
            const top5 = failedList.slice(0, 5);
            let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
            msg += "🚨 *5 ERROR TERAKHIR*" + NL;
            msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
            top5.forEach(function(f, idx) {
                msg += "*[" + (idx + 1) + "]* " + f.time + NL;
                msg += "   👥 " + f.group + NL;
                msg += "   ❌ `" + f.error + "`" + NL + NL;
            });
            msg += "━━━━━━━━━━━━━━━━━━━━";
            return replyTelegram(chatId, msg);
        } catch (err) { return replyTelegram(chatId, "❌ Gagal: " + err.message); }
    }

    if (text === "/health") {
        const stats = loadStats();
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        const uptime = process.uptime();
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        let failed = []; try { failed = fs.readJsonSync(FAILED_FILE); } catch {}
        let waStatus = { connected: false }; try { waStatus = fs.readJsonSync(STATUS_FILE); } catch {}
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📋 *HEALTH CHECK*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "🌐 WA : " + (waStatus.connected ? "Online" : "Offline") + NL;
        msg += "💾 RAM : " + ram + " MB" + NL;
        msg += "⏱ Uptime : " + days + "d " + hours + "h" + NL;
        msg += "📥 Saved : " + stats.saved + NL;
        msg += "❌ Failed : " + stats.failed + NL;
        msg += "🔴 Last Err : " + (failed.length ? failed[0].error.substring(0, 40) : "None") + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }


    if (text === "/services") {
        exec("pm2 jlist", function(err, stdout) {
            if (err) return replyTelegram(chatId, "❌ Gagal baca PM2.");
            try {
                const list = JSON.parse(stdout);
                let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
                msg += "🛠 *PM2 SERVICES*" + NL;
                msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
                list.forEach(function(proc) {
                    var statusEmoji = proc.pm2_env.status === "online" ? "🟢" : "🔴";
                    msg += statusEmoji + " *" + proc.name + "*" + NL;
                    msg += "   Status: " + proc.pm2_env.status + NL;
                    msg += "   RAM: " + (proc.monit.memory / 1024 / 1024).toFixed(1) + " MB" + NL;
                    msg += "   Restarts: " + proc.pm2_env.restart_time + NL + NL;
                });
                msg += "━━━━━━━━━━━━━━━━━━━━";
                return replyTelegram(chatId, msg);
            } catch (e) { return replyTelegram(chatId, "❌ Gagal parse PM2 data."); }
        });
        return;
    }

    if (text === "/reconnect") {
        await replyTelegram(chatId, "🔌 Reconnecting...");
        if (sock) { try { sock.end(); } catch (e) {} }
        setTimeout(function() { start(); }, 2000);
        return;
    }

    if (text === "/getqr") {
        try {
            const status = fs.readJsonSync(STATUS_FILE);
            if (status.connected) return replyTelegram(chatId, "🟢 Sudah terhubung (ONLINE).");
            if (!status.qr) return replyTelegram(chatId, "📭 QR belum di-generate. Tunggu...");
            return replyTelegram(chatId, "🔑 QR tersedia. Buka dashboard untuk scan.");
        } catch (e) { return replyTelegram(chatId, "❌ Gagal baca status."); }
    }


    // BLACKLIST COMMANDS
    if (text === "/blacklist") {
        const ignored = loadIgnoredGroups();
        if (ignored.length === 0) {
            return replyTelegram(chatId, "✅ Tidak ada grup yang di-blacklist." + NL + NL + "Untuk blacklist: `/ignore NamaGrup`" + NL + "Untuk whitelist: `/unignore NamaGrup`");
        }
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "🚫 *GRUP BLACKLIST*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        ignored.forEach(function(g, idx) {
            msg += (idx + 1) + ". " + g + NL;
        });
        msg += NL + "_Unblacklist:_ `/unignore NamaGrup`" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    if (text.startsWith("/ignore ")) {
        const groupToIgnore = text.replace("/ignore ", "").trim();
        if (!groupToIgnore) return replyTelegram(chatId, "❌ Nama grup kosong.");
        let ignored = loadIgnoredGroups();
        if (!ignored.includes(groupToIgnore)) {
            ignored.push(groupToIgnore);
            saveIgnoredGroups(ignored);
        }
        return replyTelegram(chatId, "🚫 *" + groupToIgnore + "* ditambahkan ke blacklist." + NL + "Media dari grup ini tidak akan disimpan.");
    }

    if (text.startsWith("/unignore ")) {
        const groupToUnignore = text.replace("/unignore ", "").trim();
        if (!groupToUnignore) return replyTelegram(chatId, "❌ Nama grup kosong.");
        let ignored = loadIgnoredGroups();
        ignored = ignored.filter(function(g) { return g !== groupToUnignore; });
        saveIgnoredGroups(ignored);
        return replyTelegram(chatId, "✅ *" + groupToUnignore + "* dihapus dari blacklist." + NL + "Media dari grup ini akan disimpan kembali.");
    }

    if (text.startsWith("/search ")) {
        const keyword = text.replace("/search ", "").trim().toLowerCase();
        let db = []; try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        const results = db.filter(function(x) {
            return (x.sender || "").toLowerCase().includes(keyword) || 
                   (x.number || "").toLowerCase().includes(keyword) || 
                   (x.group || "").toLowerCase().includes(keyword);
        });
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "🔍 *PENCARIAN: " + keyword + "*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "🖼 Images : " + results.filter(function(x){return x.type==="images";}).length + NL;
        msg += "🎬 Videos : " + results.filter(function(x){return x.type==="videos";}).length + NL;
        msg += "📎 Documents : " + results.filter(function(x){return x.type==="documents";}).length + NL;
        msg += "📦 Total : " + results.length + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }
}


// ==========================================
// START BOT + SCHEDULER
// ==========================================

start();
setInterval(telegramCommands, 3000);
scheduleDailySummary();

console.log("Bot started. Daily summary scheduled at 23:00.");
