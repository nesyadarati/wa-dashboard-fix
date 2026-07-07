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
var isReconnecting = false;

// GEMINI API TRACKER
var geminiTracker = { success: 0, failed: 0, lastStatus: "unknown", lastUsed: null, lastModel: null, lastError: null };


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
// CHAT LOGGER (ENHANCED - split per hari, enriched data)
// ==========================================

async function writeChatLog(groupName, logData) {
    try {
        // Split per hari: chat/2026-07-07.jsonl
        var chatDir = path.join(__dirname, "WA-MEDIA", groupName, "chat");
        await fs.ensureDir(chatDir);
        var dateStr = (logData.time || "").slice(0, 10) || moment().format("YYYY-MM-DD");
        var dailyFile = path.join(chatDir, dateStr + ".jsonl");
        await fs.appendFile(dailyFile, JSON.stringify(logData) + String.fromCharCode(10), "utf8");

        // JUGA tulis ke chat_history.jsonl (backward compatible)
        var logDir = path.join(__dirname, "WA-MEDIA", groupName);
        var legacyFile = path.join(logDir, "chat_history.jsonl");
        await fs.appendFile(legacyFile, JSON.stringify(logData) + String.fromCharCode(10), "utf8");

        // Update keyword index
        updateKeywordIndex(groupName, dateStr, logData.message);

        // Update contact registry
        updateContactRegistry(logData.number, logData.sender, groupName);

    } catch (err) {
        console.log("GAGAL MENULIS CHAT LOG:", err.message);
    }
}

// KEYWORD INDEX - untuk search instant
function updateKeywordIndex(groupName, dateStr, message) {
    try {
        var metaDir = path.join(__dirname, "WA-MEDIA", groupName, "meta");
        fs.ensureDirSync(metaDir);
        var keywordFile = path.join(metaDir, "keywords.json");

        var keywords = {};
        try { if (fs.existsSync(keywordFile)) keywords = fs.readJsonSync(keywordFile); } catch (e) {}

        // Extract kata penting (>4 huruf, bukan kata umum)
        var stopWords = ["yang", "untuk", "dengan", "sudah", "belum", "akan", "dari", "juga", "atau", "tidak", "bisa", "ada", "ini", "itu", "kalau", "karena", "tapi", "sama", "udah", "gak", "yg", "dong", "sih", "aja", "deh", "banget", "lagi", "nih", "kalo"];
        var words = (message || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
        words.forEach(function(word) {
            if (word.length > 4 && stopWords.indexOf(word) === -1) {
                if (!keywords[word]) keywords[word] = [];
                if (keywords[word].indexOf(dateStr) === -1) {
                    keywords[word].push(dateStr);
                    // Max 30 dates per keyword
                    if (keywords[word].length > 30) keywords[word] = keywords[word].slice(-30);
                }
            }
        });

        fs.writeJsonSync(keywordFile, keywords, { spaces: 2 });
    } catch (e) {}
}

// CONTACT REGISTRY - siapa itu nomor ini?
function updateContactRegistry(number, senderName, groupName) {
    try {
        if (!number || number === "unknown") return;
        var registryFile = path.join(__dirname, "contacts.json");
        var registry = {};
        try { if (fs.existsSync(registryFile)) registry = fs.readJsonSync(registryFile); } catch (e) {}

        if (!registry[number]) {
            registry[number] = {
                name: senderName,
                groups: [groupName],
                firstSeen: moment().format("YYYY-MM-DD HH:mm:ss"),
                lastSeen: moment().format("YYYY-MM-DD HH:mm:ss"),
                messageCount: 1
            };
        } else {
            registry[number].lastSeen = moment().format("YYYY-MM-DD HH:mm:ss");
            registry[number].messageCount = (registry[number].messageCount || 0) + 1;
            // Update name if changed
            if (senderName && senderName !== "Unknown") registry[number].name = senderName;
            // Add group if new
            if (registry[number].groups.indexOf(groupName) === -1) {
                registry[number].groups.push(groupName);
            }
        }

        fs.writeJsonSync(registryFile, registry, { spaces: 2 });
    } catch (e) {}
}

// DAILY STATS - precomputed per hari
function updateDailyStats(groupName, dateStr, type) {
    try {
        var metaDir = path.join(__dirname, "WA-MEDIA", groupName, "meta");
        fs.ensureDirSync(metaDir);
        var statsFile = path.join(metaDir, "daily-stats.json");

        var stats = {};
        try { if (fs.existsSync(statsFile)) stats = fs.readJsonSync(statsFile); } catch (e) {}

        if (!stats[dateStr]) stats[dateStr] = { messages: 0, images: 0, videos: 0, documents: 0, senders: [] };
        stats[dateStr].messages++;
        if (type === "images") stats[dateStr].images++;
        else if (type === "videos") stats[dateStr].videos++;
        else if (type === "documents") stats[dateStr].documents++;

        fs.writeJsonSync(statsFile, stats, { spaces: 2 });
    } catch (e) {}
}

// DAILY SUMMARY CACHE - simpan rangkuman AI biar gak perlu panggil lagi
function saveSummaryCache(groupName, dateStr, summary) {
    try {
        var summaryDir = path.join(__dirname, "WA-MEDIA", groupName, "summaries");
        fs.ensureDirSync(summaryDir);
        var summaryFile = path.join(summaryDir, dateStr + ".json");
        fs.writeJsonSync(summaryFile, {
            date: dateStr,
            generatedAt: moment().format("YYYY-MM-DD HH:mm:ss"),
            summary: summary
        }, { spaces: 2 });
    } catch (e) {}
}

function getSummaryCache(groupName, dateStr) {
    try {
        var summaryFile = path.join(__dirname, "WA-MEDIA", groupName, "summaries", dateStr + ".json");
        if (fs.existsSync(summaryFile)) {
            var data = fs.readJsonSync(summaryFile);
            return data.summary || null;
        }
    } catch (e) {}
    return null;
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

async function sendTelegramDocument(chatId, filePath, caption) {
    try {
        var FormData = require("form-data");
        var form = new FormData();
        form.append("chat_id", chatId);
        form.append("document", fs.createReadStream(filePath));
        if (caption) form.append("caption", caption.substring(0, 1024));
        form.append("parse_mode", "Markdown");

        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendDocument", form, {
            headers: form.getHeaders(),
            timeout: 60000
        });
    } catch (err) { console.log("TELEGRAM SEND DOC ERROR", err.message); }
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
            if (!isReconnecting) {
                await sendMainMenuTelegram();
            }
            isReconnecting = false;
        }
        if (connection === "close") {
            saveStatus({ connected: false });
            console.log("CONNECTION CLOSED");

            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && !isReconnecting) {
                console.log("RECONNECTING IN 5 SECONDS...");
                isReconnecting = true;
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

            // Anti-delete detection + save to log
            if (msg.message.protocolMessage && msg.message.protocolMessage.type === 3) {
                const targetDeletedId = msg.message.protocolMessage.key.id;
                let NL = String.fromCharCode(10);

                // Save to antidelete-log.json
                const ANTIDELETE_FILE = path.join(__dirname, "antidelete-log.json");
                let adLogs = [];
                try { if (fs.existsSync(ANTIDELETE_FILE)) adLogs = fs.readJsonSync(ANTIDELETE_FILE); } catch {}
                adLogs.unshift({
                    time: moment().format("YYYY-MM-DD HH:mm:ss"),
                    group: groupName,
                    sender: senderName,
                    number: senderNumber,
                    messageId: targetDeletedId,
                    content: "(pesan ditarik)"
                });
                if (adLogs.length > 500) adLogs = adLogs.slice(0, 500);
                fs.writeJsonSync(ANTIDELETE_FILE, adLogs, { spaces: 2 });

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


            // Log chat text (ENRICHED FORMAT)
            const textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption || 
                                msg.message.videoMessage?.caption || "";

            if (textMessage.trim()) {
                // Detect reply context
                var replyTo = null;
                var quotedMsg = null;
                if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    replyTo = msg.message.extendedTextMessage.contextInfo.stanzaId || null;
                    quotedMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage.conversation ||
                                msg.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text || null;
                    if (quotedMsg && quotedMsg.length > 100) quotedMsg = quotedMsg.substring(0, 100) + "...";
                }

                // Detect mentions
                var mentions = [];
                if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid) {
                    mentions = msg.message.extendedTextMessage.contextInfo.mentionedJid.map(function(jid) {
                        return jid.split("@")[0];
                    });
                }

                // Detect forward
                var isForward = !!(msg.message.extendedTextMessage?.contextInfo?.isForwarded);

                // Determine chat type
                var chatType = "text";
                if (msg.message.imageMessage?.caption || msg.message.videoMessage?.caption) chatType = "media_caption";
                else if (replyTo) chatType = "reply";
                else if (isForward) chatType = "forward";

                await writeChatLog(groupName, {
                    id: msg.key.id,
                    time: msgTime.format("YYYY-MM-DD HH:mm:ss"),
                    sender: senderName,
                    number: senderNumber,
                    message: textMessage.trim(),
                    type: chatType,
                    replyTo: replyTo,
                    quotedMsg: quotedMsg,
                    mediaRef: null,
                    mentions: mentions,
                    isForward: isForward
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

            // Update daily stats
            updateDailyStats(groupName, msgTime.format("YYYY-MM-DD"), type);

            // Jika ada caption, update mediaRef di chat log terakhir
            var captionText = msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
            if (captionText.trim()) {
                // Write chat entry with media reference
                await writeChatLog(groupName, {
                    id: msg.key.id + "_media",
                    time: msgTime.format("YYYY-MM-DD HH:mm:ss"),
                    sender: senderName,
                    number: senderNumber,
                    message: captionText.trim(),
                    type: "media_caption",
                    replyTo: null,
                    quotedMsg: null,
                    mediaRef: fileName,
                    mediaType: type,
                    mentions: [],
                    isForward: false
                });
            }
            
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
// TELEGRAM MENU (Reply Keyboard - muncul saat klik tombol menu)
// ==========================================

async function sendMainMenuTelegram() {
    try {
        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendMessage", {
            chat_id: process.env.CHAT_ID,
            text: "📱 *WA Media Bot - Connected*" + String.fromCharCode(10) + String.fromCharCode(10) + "Klik tombol menu di bawah untuk mengakses fitur bot.",
            parse_mode: "Markdown",
            reply_markup: {
                keyboard: [
                    [{ text: "📊 Overview" }, { text: "🛠 Sistem" }, { text: "📅 Hari Ini" }],
                    [{ text: "📈 7D Chart" }, { text: "🚨 Logs Error" }, { text: "📊 Summary" }],
                    [{ text: "🔌 Reconnect" }, { text: "🚫 Blacklist" }, { text: "🗑 Anti-Delete" }],
                    [{ text: "📝 Rangkum Chat" }, { text: "📋 Report" }, { text: "🧠 Tanya AI" }],
                    [{ text: "🔍 Menu" }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        });
    } catch (e) { console.log("Gagal kirim menu:", e.message); }
}

async function sendInlineMenu(chatId) {
    try {
        var NL = String.fromCharCode(10);
        var menuText = "";
        menuText += "📱 *WA MEDIA BOT - MENU*" + NL;
        menuText += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        menuText += "Pilih fitur yang ingin diakses:" + NL + NL;
        menuText += "📊 *Overview* — Status WA + statistik + top grup hari ini" + NL;
        menuText += "🛠 *Sistem* — RAM, uptime, PM2, Gemini API status" + NL;
        menuText += "📅 *Hari Ini* — Detail aktivitas hari ini (grup + pengirim)" + NL;
        menuText += "📈 *7D Chart* — Grafik aktivitas 7 hari terakhir" + NL;
        menuText += "🚨 *Logs Error* — Lihat 5 error terakhir" + NL;
        menuText += "📊 *Summary* — Kirim laporan harian lengkap" + NL;
        menuText += "🔌 *Reconnect* — Putuskan & sambung ulang WA" + NL;
        menuText += "🚫 *Blacklist* — Lihat/kelola grup yang diabaikan" + NL;
        menuText += "🗑 *Anti-Delete* — Lihat pesan yang ditarik" + NL;
        menuText += "📝 *Rangkum* — Rangkum isi chat grup per tanggal" + NL;
        menuText += "📋 *Report* — Buat laporan lengkap grup + statistik" + NL;
        menuText += "🧠 *Tanya AI* — Tanya apapun (tambah `pdf` di akhir = kirim PDF)" + NL;
        menuText += NL + "━━━━━━━━━━━━━━━━━━━━";

        await axios.post("https://api.telegram.org/bot" + process.env.BOT_TOKEN + "/sendMessage", {
            chat_id: chatId,
            text: menuText,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📊 Overview", callback_data: "/overview" }, { text: "🛠 Sistem", callback_data: "/sistem" }, { text: "📅 Hari Ini", callback_data: "/today" }],
                    [{ text: "📈 7D Chart", callback_data: "/chart" }, { text: "🚨 Logs Error", callback_data: "/viewlogs" }, { text: "📊 Summary", callback_data: "/summary_now" }],
                    [{ text: "🔌 Reconnect", callback_data: "/reconnect" }, { text: "🚫 Blacklist", callback_data: "/blacklist" }, { text: "🗑 Anti-Delete", callback_data: "/antidelete" }],
                    [{ text: "📝 Rangkum", callback_data: "/rangkum_help" }, { text: "📋 Report", callback_data: "/report_help" }, { text: "🧠 Tanya AI", callback_data: "/ask_help" }]
                ]
            }
        });
    } catch (e) { console.log("Gagal kirim inline menu:", e.message); }
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

    try {

    // Map reply keyboard button texts to commands
    if (text === "📊 Overview" || text === "📊 Stats" || text === "🟢 Status") text = "/overview";
    if (text === "🛠 Sistem" || text === "📋 Health" || text === "🛠 Services") text = "/sistem";
    if (text === "📅 Hari Ini") text = "/today";
    if (text === "📈 7D Chart") text = "/chart";
    if (text === "🚨 Logs Error") text = "/viewlogs";
    if (text === "📊 Summary") text = "/summary_now";
    if (text === "🔌 Reconnect") text = "/reconnect";
    if (text === "🎨 QR Code") text = "/getqr";
    if (text === "🚫 Blacklist") text = "/blacklist";
    if (text === "🗑 Anti-Delete") text = "/antidelete";
    if (text === "🔍 Menu") text = "/menu";
    if (text === "📝 Rangkum Chat" || text === "/rangkum_help") {
        return replyTelegram(chatId, "📝 *Cara Rangkum Chat:*" + String.fromCharCode(10) + String.fromCharCode(10) + "Ketik: `/rangkum NamaGrup`" + String.fromCharCode(10) + "Contoh: `/rangkum Podomoro Park Bandung `" + String.fromCharCode(10) + String.fromCharCode(10) + "Untuk tanggal tertentu:" + String.fromCharCode(10) + "`/rangkum Podomoro Park Bandung  2026-07-05`" + String.fromCharCode(10) + String.fromCharCode(10) + "Tanpa tanggal = rangkum hari ini.");
    }

    if (text === "📋 Report" || text === "/report_help") {
        return replyTelegram(chatId, "📋 *Cara Buat Report:*" + String.fromCharCode(10) + String.fromCharCode(10) + "Ketik: `/report NamaGrup`" + String.fromCharCode(10) + String.fromCharCode(10) + "Opsi waktu:" + String.fromCharCode(10) + "`/report NamaGrup hari-ini`" + String.fromCharCode(10) + "`/report NamaGrup kemarin`" + String.fromCharCode(10) + "`/report NamaGrup minggu-ini`" + String.fromCharCode(10) + "`/report NamaGrup 2026-07-05`" + String.fromCharCode(10) + String.fromCharCode(10) + "Tanpa opsi = hari ini.");
    }

    if (text === "🧠 Tanya AI" || text === "/ask_help") {
        return replyTelegram(chatId, "🧠 *AI Assistant*" + String.fromCharCode(10) + String.fromCharCode(10) + "Tanya apapun tentang data grup WA kamu:" + String.fromCharCode(10) + String.fromCharCode(10) + "`/tanya grup bandung hari ini`" + String.fromCharCode(10) + "`/tanya siapa yang paling aktif?`" + String.fromCharCode(10) + "`/tanya ada keputusan apa kemarin?`" + String.fromCharCode(10) + String.fromCharCode(10) + "Mau hasilnya PDF? Tambah `pdf` di akhir:" + String.fromCharCode(10) + "`/tanya grup bandung hari ini pdf`" + String.fromCharCode(10) + "`/tanya rangkum minggu ini pdf`");
    }

    if (text === "/start" || text === "/menu") {
        return sendInlineMenu(chatId);
    }

    if (text === "/overview" || text === "/stats" || text === "/status") {
        let stats = loadStats();
        let status = { connected: false }; try { status = fs.readJsonSync(STATUS_FILE); } catch {}
        let db = []; try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        var todayStr = moment().format("YYYY-MM-DD");
        var todayMedia = db.filter(function(x) { return x.time && x.time.startsWith(todayStr); });
        var todayImages = todayMedia.filter(function(x){return x.type==="images";}).length;
        var todayVideos = todayMedia.filter(function(x){return x.type==="videos";}).length;
        var todayDocs = todayMedia.filter(function(x){return x.type==="documents";}).length;

        // Top 3 grup hari ini
        var grupToday = {};
        todayMedia.forEach(function(x) { grupToday[x.group] = (grupToday[x.group] || 0) + 1; });
        var topGrups = Object.entries(grupToday).sort(function(a,b){return b[1]-a[1];}).slice(0,3);

        // Uptime
        var uptimeSec = process.uptime();
        var uptimeDays = Math.floor(uptimeSec / 86400);
        var uptimeHours = Math.floor((uptimeSec % 86400) / 3600);

        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📊 *OVERVIEW*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += (status.connected ? "🟢" : "🔴") + " WhatsApp: *" + (status.connected ? "ONLINE" : "OFFLINE") + "*" + NL;
        msg += "⏱ Uptime: " + uptimeDays + "d " + uptimeHours + "h" + NL;
        msg += "💾 Saved: *" + stats.saved + "* | Failed: *" + stats.failed + "*" + NL + NL;
        msg += "📥 *Hari Ini (" + todayStr + "):*" + NL;
        msg += "   📷 " + todayImages + " gambar | 🎬 " + todayVideos + " video | 📎 " + todayDocs + " dok" + NL + NL;
        msg += "📦 *Total Keseluruhan:*" + NL;
        msg += "   🖼 " + db.filter(function(x){return x.type==="images";}).length + " | 🎬 " + db.filter(function(x){return x.type==="videos";}).length + " | 📎 " + db.filter(function(x){return x.type==="documents";}).length + " | 📦 " + db.length + NL;
        if (topGrups.length > 0) {
            msg += NL + "🏆 *Top Grup Hari Ini:*" + NL;
            topGrups.forEach(function(g, i) { msg += "   " + ["🥇","🥈","🥉"][i] + " " + g[0] + " (" + g[1] + ")" + NL; });
        }
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    if (text === "/today") {
        let db = []; try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch {}
        var todayStr = moment().format("YYYY-MM-DD");
        var todayMedia = db.filter(function(x) { return x.time && x.time.startsWith(todayStr); });
        var senderCount = {};
        todayMedia.forEach(function(x) { senderCount[x.sender || "Unknown"] = (senderCount[x.sender || "Unknown"] || 0) + 1; });
        var topSenders = Object.entries(senderCount).sort(function(a,b){return b[1]-a[1];}).slice(0,5);
        var grupCount = {};
        todayMedia.forEach(function(x) { grupCount[x.group] = (grupCount[x.group] || 0) + 1; });
        var topGrups = Object.entries(grupCount).sort(function(a,b){return b[1]-a[1];}).slice(0,5);

        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "📅 *HARI INI (" + todayStr + ")*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "📷 " + todayMedia.filter(function(x){return x.type==="images";}).length + " gambar" + NL;
        msg += "🎬 " + todayMedia.filter(function(x){return x.type==="videos";}).length + " video" + NL;
        msg += "📎 " + todayMedia.filter(function(x){return x.type==="documents";}).length + " dokumen" + NL;
        msg += "📦 Total: *" + todayMedia.length + "* file" + NL + NL;
        if (topGrups.length > 0) {
            msg += "*Grup Aktif:*" + NL;
            topGrups.forEach(function(g) { msg += "• " + g[0] + " (" + g[1] + ")" + NL; });
            msg += NL;
        }
        if (topSenders.length > 0) {
            msg += "*Pengirim Aktif:*" + NL;
            topSenders.forEach(function(s) { msg += "• " + s[0] + " (" + s[1] + ")" + NL; });
        }
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

    if (text === "/sistem" || text === "/health" || text === "/services") {
        const stats = loadStats();
        const ram = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
        const uptime = process.uptime();
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        let failed = []; try { failed = fs.readJsonSync(FAILED_FILE); } catch {}
        let waStatus = { connected: false }; try { waStatus = fs.readJsonSync(STATUS_FILE); } catch {}

        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "🛠 *SISTEM*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        msg += "*💻 Server:*" + NL;
        msg += "   RAM: " + ram + " MB" + NL;
        msg += "   Uptime: " + days + "d " + hours + "h " + mins + "m" + NL;
        msg += "   Node: " + process.version + NL + NL;
        msg += "*🤖 Gemini AI:*" + NL;
        msg += "   Status: " + (geminiTracker.lastStatus || "belum dipakai") + NL;
        msg += "   Model: " + (geminiTracker.lastModel || "-") + NL;
        msg += "   Sukses: " + geminiTracker.success + " | Gagal: " + geminiTracker.failed + NL;
        msg += "   Terakhir: " + (geminiTracker.lastUsed || "-") + NL;
        if (geminiTracker.lastError) msg += "   Error: " + geminiTracker.lastError + NL;
        msg += NL;
        msg += "*🔴 Error Terakhir:*" + NL;
        msg += "   " + (failed.length ? String(failed[0].error || "").substring(0, 50) : "Tidak ada") + NL;
        msg += "   " + (failed.length ? (failed[0].time || "") : "") + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";

        // Tambah info PM2 jika bisa
        exec("pm2 jlist", function(err, stdout) {
            if (!err) {
                try {
                    var list = JSON.parse(stdout);
                    var pmMsg = NL + "*📦 PM2 Services:*" + NL;
                    list.forEach(function(proc) {
                        var emoji = proc.pm2_env.status === "online" ? "🟢" : "🔴";
                        pmMsg += "   " + emoji + " " + proc.name + " | " + (proc.monit.memory / 1024 / 1024).toFixed(0) + "MB | ↺" + proc.pm2_env.restart_time + NL;
                    });
                    pmMsg += "━━━━━━━━━━━━━━━━━━━━";
                    replyTelegram(chatId, msg + pmMsg);
                } catch(e) { replyTelegram(chatId, msg + "━━━━━━━━━━━━━━━━━━━━"); }
            } else {
                replyTelegram(chatId, msg + "━━━━━━━━━━━━━━━━━━━━");
            }
        });
        return;
    }


    // /services merged into /sistem

    if (text === "/reconnect") {
        await replyTelegram(chatId, "🔌 Reconnecting...");
        isReconnecting = true;
        if (sock) { try { sock.end(); } catch (e) {} }
        setTimeout(function() { start(); }, 3000);
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

    // ANTI-DELETE VIEWER - lihat pesan yang dihapus
    if (text === "/antidelete") {
        const ANTIDELETE_FILE = path.join(__dirname, "antidelete-log.json");
        let logs = [];
        try { if (fs.existsSync(ANTIDELETE_FILE)) logs = fs.readJsonSync(ANTIDELETE_FILE); } catch {}
        if (logs.length === 0) {
            return replyTelegram(chatId, "✅ Belum ada pesan yang ditarik/dihapus tercatat.");
        }
        const recent = logs.slice(0, 10);
        let msg = "━━━━━━━━━━━━━━━━━━━━" + NL;
        msg += "🗑 *PESAN DIHAPUS/DITARIK*" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        recent.forEach(function(item, idx) {
            msg += "*[" + (idx + 1) + "]* " + (item.time || "-") + NL;
            msg += "   👥 " + (item.group || "-") + NL;
            msg += "   👤 " + (item.sender || "-") + NL;
            msg += "   💬 " + (item.content || "_media/unknown_") + NL + NL;
        });
        msg += "_Total tercatat: " + logs.length + " pesan_" + NL;
        msg += "━━━━━━━━━━━━━━━━━━━━";
        return replyTelegram(chatId, msg);
    }

    // AI ASSISTANT - /ask command (with optional PDF output)
    if (text.startsWith("/ask ") || text.startsWith("/tanya ")) {
        var question = text.replace(/^\/(ask|tanya) /, "").trim();
        if (!question) return replyTelegram(chatId, "Format: `/tanya pertanyaan kamu`" + NL + "Contoh: `/tanya grup bandung hari ini`" + NL + NL + "Mau PDF? Tambah `pdf` di akhir:" + NL + "`/tanya grup bandung hari ini pdf`");

        // Cek apakah user mau output PDF
        var wantPDF = false;
        if (question.toLowerCase().endsWith(" pdf")) {
            wantPDF = true;
            question = question.substring(0, question.length - 4).trim();
        }

        await replyTelegram(chatId, wantPDF ? "📄 Membuat PDF..." : "🧠 Memproses pertanyaan...");

        try {
            // Timeout wrapper - max 90 detik
            var answer = await Promise.race([
                askAIAssistant(question),
                new Promise(function(_, reject) {
                    setTimeout(function() { reject(new Error("Timeout 90 detik - AI terlalu lama merespon")); }, 90000);
                })
            ]);

            if (wantPDF) {
                // Generate PDF dari jawaban AI
                var tmpDir = path.join(__dirname, "tmp");
                fs.ensureDirSync(tmpDir);
                var pdfFileName = "Laporan_" + moment().format("YYYYMMDD_HHmmss") + ".pdf";
                var pdfPath = path.join(tmpDir, pdfFileName);

                await generateAnswerPDF(pdfPath, question, answer);
                await sendTelegramDocument(chatId, pdfPath, "📄 Hasil: _" + question + "_");

                // Cleanup
                setTimeout(function() { try { fs.removeSync(pdfPath); } catch (e) {} }, 10000);
            } else {
                await replyTelegram(chatId, answer);
            }
        } catch (err) {
            await replyTelegram(chatId, "❌ Gagal: " + (err.message || String(err)).substring(0, 200));
        }
        return;
    }

    // REPORT COMMAND - laporan ringkas + statistik (buat jawab boss)
    if (text.startsWith("/report ")) {
        var reportParts = text.replace("/report ", "").trim().split(" ");
        var reportDate = null;
        var reportRange = null;

        // Cek apakah ada keyword waktu
        var lastPart = reportParts[reportParts.length - 1];
        if (lastPart === "hari-ini" || lastPart === "today") {
            reportParts.pop();
            reportDate = moment().format("YYYY-MM-DD");
            reportRange = reportDate;
        } else if (lastPart === "kemarin" || lastPart === "yesterday") {
            reportParts.pop();
            reportDate = moment().subtract(1, "days").format("YYYY-MM-DD");
            reportRange = reportDate;
        } else if (lastPart === "minggu-ini" || lastPart === "this-week") {
            reportParts.pop();
            reportDate = moment().startOf("week").format("YYYY-MM-DD");
            reportRange = moment().format("YYYY-MM-DD");
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(lastPart)) {
            reportParts.pop();
            reportDate = lastPart;
            reportRange = lastPart;
        }

        var reportGroup = reportParts.join(" ");
        if (!reportGroup) return replyTelegram(chatId, "Format: `/report NamaGrup`" + NL + "Opsi: `/report NamaGrup hari-ini`" + NL + "`/report NamaGrup kemarin`" + NL + "`/report NamaGrup minggu-ini`" + NL + "`/report NamaGrup 2026-07-05`");

        if (!reportDate) { reportDate = moment().format("YYYY-MM-DD"); reportRange = reportDate; }

        await replyTelegram(chatId, "📋 Membuat laporan *" + reportGroup + "*...");

        try {
            var reportResult = await generateReport(reportGroup, reportDate, reportRange);
            await replyTelegram(chatId, reportResult);
        } catch (err) {
            await replyTelegram(chatId, "❌ Gagal: " + err.message);
        }
        return;
    }

    // RANGKUMAN CHAT DENGAN GEMINI AI
    if (text.startsWith("/rangkum ")) {
        var parts = text.replace("/rangkum ", "").trim().split(" ");
        var targetDate = null;

        // Cek apakah bagian terakhir adalah tanggal (format YYYY-MM-DD)
        if (parts.length > 1 && /^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length - 1])) {
            targetDate = parts.pop();
        }
        var groupName = parts.join(" ");

        if (!groupName) return replyTelegram(chatId, "Format: `/rangkum NamaGrup` atau `/rangkum NamaGrup 2026-07-05`");

        if (!targetDate) targetDate = moment().format("YYYY-MM-DD");

        await replyTelegram(chatId, "🤖 Memproses rangkuman chat *" + groupName + "* tanggal " + targetDate + "...");

        try {
            var summary = await generateChatSummary(groupName, targetDate);
            await replyTelegram(chatId, summary);
        } catch (err) {
            await replyTelegram(chatId, "❌ Gagal merangkum: " + err.message);
        }
        return;
    }

    } catch (cmdErr) {
        console.log("COMMAND HANDLER ERROR:", cmdErr.message);
        try { await replyTelegram(chatId, "❌ Error: " + (cmdErr.message || "Unknown").substring(0, 200)); } catch (e) {}
    }
}


// ==========================================
// GEMINI AI - RANGKUMAN CHAT
// ==========================================

async function generateChatSummary(groupName, targetDate) {
    var NL = String.fromCharCode(10);

    if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL) {
        throw new Error("LLM_BASE_URL atau LLM_API_KEY belum diset di .env");
    }

    // CHECK CACHE FIRST
    var cached = getSummaryCache(groupName, targetDate);
    if (cached) {
        var output = "";
        output += "━━━━━━━━━━━━━━━━━━━━" + NL;
        output += "📝 *RANGKUMAN CHAT*" + NL;
        output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        output += "👥 *Grup:* " + groupName + NL;
        output += "📅 *Tanggal:* " + targetDate + NL;
        output += "💾 _(dari cache)_" + NL + NL;
        output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
        output += cached + NL + NL;
        output += "━━━━━━━━━━━━━━━━━━━━";
        return output;
    }

    // Try daily file first, fallback to legacy
    var chatDir = path.join(__dirname, "WA-MEDIA", groupName, "chat");
    var dailyFile = path.join(chatDir, targetDate + ".jsonl");
    var logFile = path.join(__dirname, "WA-MEDIA", groupName, "chat_history.jsonl");

    var chats = [];
    if (fs.existsSync(dailyFile)) {
        // Load from daily split file (faster)
        var content = fs.readFileSync(dailyFile, "utf8");
        content.trim().split(String.fromCharCode(10)).filter(Boolean).forEach(function(line) {
            try { chats.push(JSON.parse(line)); } catch (e) {}
        });
    } else if (fs.existsSync(logFile)) {
        // Fallback to legacy file
        var content = fs.readFileSync(logFile, "utf8");
        content.trim().split(String.fromCharCode(10)).filter(Boolean).forEach(function(line) {
            try {
                var chat = JSON.parse(line);
                if (chat.time && chat.time.startsWith(targetDate)) chats.push(chat);
            } catch (e) {}
        });
    }

    if (chats.length === 0) {
        throw new Error("Tidak ada chat pada tanggal " + targetDate + " di grup " + groupName);
    }

    // Format chat untuk dikirim ke Gemini
    var chatText = chats.map(function(c) {
        return "[" + c.time + "] " + c.sender + ": " + c.message;
    }).join(String.fromCharCode(10));

    // Batasi panjang (Gemini ada limit token)
    if (chatText.length > 15000) {
        chatText = chatText.substring(chatText.length - 15000);
    }

    // Prompt untuk LLM
    var prompt = "Kamu adalah asisten yang merangkum percakapan grup WhatsApp. Berikut adalah log chat grup '" + groupName + "' pada tanggal " + targetDate + "." + String.fromCharCode(10) + String.fromCharCode(10);
    prompt += "Buatkan rangkuman dalam Bahasa Indonesia dengan format:" + String.fromCharCode(10);
    prompt += "1. TOPIK UTAMA - apa saja yang dibahas" + String.fromCharCode(10);
    prompt += "2. RENCANA & TARGET - jika ada rencana/target yang disepakati" + String.fromCharCode(10);
    prompt += "3. KEPUTUSAN - keputusan yang diambil" + String.fromCharCode(10);
    prompt += "4. HIGHLIGHT - hal penting/menarik" + String.fromCharCode(10);
    prompt += "5. KESIMPULAN - rangkuman singkat 1-2 kalimat" + String.fromCharCode(10) + String.fromCharCode(10);
    prompt += "Jika salah satu bagian tidak ada, skip saja. Tulis ringkas dan padat." + String.fromCharCode(10);
    prompt += "PENTING: JANGAN gunakan format markdown seperti **bold**, *italic*, ##heading, atau simbol formatting lainnya. Tulis plain text saja." + String.fromCharCode(10) + String.fromCharCode(10);
    prompt += "--- LOG CHAT ---" + String.fromCharCode(10);
    prompt += chatText;

    // Panggil Gemini API
    var aiText = await callGemini(prompt);

    // Format output
    var output = "";
    output += "━━━━━━━━━━━━━━━━━━━━" + NL;
    output += "📝 *RANGKUMAN CHAT*" + NL;
    output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
    output += "👥 *Grup:* " + groupName + NL;
    output += "📅 *Tanggal:* " + targetDate + NL;
    output += "💬 *Total Pesan:* " + chats.length + NL;
    output += "👤 *Partisipan:* " + getUniqueCount(chats) + " orang" + NL + NL;
    output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
    output += aiText + NL + NL;
    output += "━━━━━━━━━━━━━━━━━━━━";

    // SAVE TO CACHE
    saveSummaryCache(groupName, targetDate, aiText);

    return output;
}

function getUniqueCount(chats) {
    var senders = {};
    chats.forEach(function(c) { senders[c.sender] = true; });
    return Object.keys(senders).length;
}

// ==========================================
// GENERATE REPORT (untuk Telegram - ringkas)
// ==========================================

async function generateReport(groupName, startDate, endDate) {
    var NL = String.fromCharCode(10);
    if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL) throw new Error("LLM_BASE_URL atau LLM_API_KEY belum diset di .env");

    // Baca chat
    var logFile = path.join(__dirname, "WA-MEDIA", groupName, "chat_history.jsonl");
    var chats = [];
    if (fs.existsSync(logFile)) {
        var content = fs.readFileSync(logFile, "utf8");
        var lines = content.trim().split(String.fromCharCode(10)).filter(Boolean);
        lines.forEach(function(line) {
            try {
                var chat = JSON.parse(line);
                var chatDate = (chat.time || "").slice(0, 10);
                if (chatDate >= startDate && chatDate <= endDate) chats.push(chat);
            } catch (e) {}
        });
    }

    // Hitung media
    var mediaDir = path.join(__dirname, "WA-MEDIA", groupName);
    var photoCount = 0, videoCount = 0, docCount = 0;
    function countMedia(dir) {
        if (!fs.existsSync(dir)) return;
        var items = fs.readdirSync(dir);
        items.forEach(function(item) {
            var full = path.join(dir, item);
            var stat = fs.statSync(full);
            if (stat.isDirectory()) { countMedia(full); }
            else {
                var fileDate = stat.mtime.toISOString().slice(0, 10);
                if (fileDate >= startDate && fileDate <= endDate) {
                    var ext = path.extname(item).toLowerCase();
                    if ([".jpg", ".jpeg", ".png", ".webp"].indexOf(ext) !== -1) photoCount++;
                    else if ([".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].indexOf(ext) !== -1) videoCount++;
                    else if (item !== "chat_history.jsonl") docCount++;
                }
            }
        });
    }
    countMedia(mediaDir);

    if (chats.length === 0 && photoCount === 0) {
        throw new Error("Tidak ada data pada periode " + startDate + " s/d " + endDate);
    }

    // Chat text untuk AI
    var chatText = chats.map(function(c) {
        return "[" + c.time + "] " + c.sender + ": " + c.message;
    }).join(NL);
    if (chatText.length > 10000) chatText = chatText.substring(chatText.length - 10000);

    // Prompt - bahasa manusia, ringkas untuk dibaca cepat
    var prompt = "Kamu membantu seorang project manager membuat laporan ringkas dari chat WhatsApp grup proyek." + NL;
    prompt += "Tulis dalam Bahasa Indonesia yang NATURAL - seperti kamu cerita ke teman soal apa yang terjadi." + NL;
    prompt += "Jangan pakai format kaku atau robot. Tulis singkat, padat, mudah dibaca dalam 30 detik." + NL;
    prompt += "PENTING: JANGAN gunakan format markdown seperti **bold**, *italic*, ##heading, atau simbol formatting lainnya. Tulis plain text saja." + NL + NL;
    prompt += "Grup: " + groupName + NL;
    prompt += "Periode: " + startDate + " s/d " + endDate + NL + NL;
    prompt += "Buatkan laporan ringkas mencakup:" + NL;
    prompt += "- Apa yang terjadi (aktivitas utama)" + NL;
    prompt += "- Ada keputusan/target apa" + NL;
    prompt += "- Ada masalah/kendala gak" + NL;
    prompt += "- Kesimpulan 1 kalimat" + NL + NL;
    prompt += "--- CHAT ---" + NL + chatText;

    // Panggil Gemini
    var aiText = await callGemini(prompt);
    if (!aiText) throw new Error("Tidak ada hasil dari AI");

    // Format output
    var periodLabel = (startDate === endDate) ? startDate : startDate + " s/d " + endDate;
    var uniqueSenders = getUniqueCount(chats);

    var output = "";
    output += "━━━━━━━━━━━━━━━━━━━━" + NL;
    output += "📋 *LAPORAN GRUP*" + NL;
    output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
    output += "👥 " + groupName + NL;
    output += "📅 " + periodLabel + NL;
    output += "💬 " + chats.length + " pesan | 👤 " + uniqueSenders + " orang" + NL;
    output += "📷 " + photoCount + " foto | 🎬 " + videoCount + " video | 📎 " + docCount + " dok" + NL;
    output += NL + "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
    output += aiText + NL + NL;
    output += "━━━━━━━━━━━━━━━━━━━━";

    return output;
}


// ==========================================
// PDF GENERATOR - laporan rapih + foto dari grup
// ==========================================

async function generateAnswerPDF(outputPath, question, answer) {
    return new Promise(function(resolve, reject) {
        try {
            var PDFDocument = require("pdfkit");
            var doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true });
            var stream = fs.createWriteStream(outputPath);
            doc.pipe(stream);

            var pageWidth = doc.page.width - 100;
            var NL = String.fromCharCode(10);

            // === DETEKSI GRUP & TANGGAL ===
            var mediaDir = path.join(__dirname, "WA-MEDIA");
            var grupList = [];
            try {
                if (fs.existsSync(mediaDir)) {
                    grupList = fs.readdirSync(mediaDir).filter(function(item) {
                        try { return fs.statSync(path.join(mediaDir, item)).isDirectory(); } catch(e) { return false; }
                    });
                }
            } catch (e) {}

            var detectedGrup = null;
            var questionLower = question.toLowerCase();
            grupList.forEach(function(g) {
                if (questionLower.indexOf(g.toLowerCase()) !== -1) detectedGrup = g;
                var words = g.toLowerCase().split(" ");
                words.forEach(function(w) {
                    if (w.length > 4 && questionLower.indexOf(w) !== -1 && !detectedGrup) detectedGrup = g;
                });
            });

            var targetDate = null;
            if (questionLower.indexOf("hari ini") !== -1 || questionLower.indexOf("today") !== -1) {
                targetDate = moment().format("YYYY-MM-DD");
            } else if (questionLower.indexOf("kemarin") !== -1 || questionLower.indexOf("kemaren") !== -1) {
                targetDate = moment().subtract(1, "days").format("YYYY-MM-DD");
            } else if (questionLower.indexOf("minggu ini") !== -1) {
                targetDate = moment().subtract(7, "days").format("YYYY-MM-DD");
            }
            var dateMatch = question.match(/\d{4}-\d{2}-\d{2}/);
            if (dateMatch) targetDate = dateMatch[0];
            if (!targetDate) targetDate = moment().subtract(7, "days").format("YYYY-MM-DD");
            var endDate = moment().format("YYYY-MM-DD");

            // === KUMPULKAN FOTO ===
            var photos = [];
            if (detectedGrup) {
                function findPhotos(dir) {
                    if (!fs.existsSync(dir)) return;
                    try {
                        var items = fs.readdirSync(dir);
                        items.forEach(function(item) {
                            var full = path.join(dir, item);
                            try {
                                var stat = fs.statSync(full);
                                if (stat.isDirectory()) findPhotos(full);
                                else {
                                    var ext = path.extname(item).toLowerCase();
                                    if ([".jpg", ".jpeg", ".png"].indexOf(ext) !== -1) {
                                        var fileDate = stat.mtime.toISOString().slice(0, 10);
                                        if (fileDate >= targetDate && fileDate <= endDate) {
                                            photos.push({ path: full, date: fileDate, size: stat.size });
                                        }
                                    }
                                }
                            } catch (e) {}
                        });
                    } catch (e) {}
                }
                findPhotos(path.join(mediaDir, detectedGrup));
                photos.sort(function(a, b) { return b.date.localeCompare(a.date); });
                photos = photos.slice(0, 12);
            }

            // === BERSIHKAN TEKS AI ===
            var cleanAnswer = (answer || "")
                .replace(/━+/g, "")
                .replace(/🧠 \*AI ASSISTANT\*/g, "")
                .replace(/❓ _.*?_\n?/g, "")
                .replace(/\*\*([^*]+)\*\*/g, "$1")
                .replace(/\*([^*]+)\*/g, "$1")
                .replace(/_([^_]+)_/g, "$1")
                .replace(/`([^`]+)`/g, "$1")
                .replace(/^#{1,3}\s*/gm, "")
                .replace(/^\s*[-•]\s*/gm, "  - ")
                .trim();

            // Hapus baris pembuka AI (Tentu, Baik, Berikut, dll)
            var cleanLines = cleanAnswer.split(NL);
            while (cleanLines.length > 0) {
                var firstLine = cleanLines[0].toLowerCase().trim();
                if (!firstLine || firstLine.startsWith("tentu") || firstLine.startsWith("baik") || firstLine.startsWith("berikut") || firstLine.startsWith("ini adalah") || firstLine.startsWith("ini rangkuman") || firstLine.startsWith("oke") || firstLine.startsWith("sure")) {
                    cleanLines.shift();
                } else {
                    break;
                }
            }
            cleanAnswer = cleanLines.join(NL).trim();

            // ==========================
            // RENDER PDF
            // ==========================

            // === HEADER (compact) ===
            doc.moveDown(1);
            doc.fontSize(24).font("Helvetica-Bold").fillColor("#1a1a1a")
               .text("LAPORAN PROYEK", { align: "center" });
            doc.moveDown(0.3);

            if (detectedGrup) {
                doc.fontSize(14).font("Helvetica").fillColor("#333333")
                   .text(detectedGrup, { align: "center" });
            }
            doc.moveDown(0.5);

            // Garis hijau
            doc.strokeColor("#25D366").lineWidth(2)
               .moveTo(150, doc.y).lineTo(doc.page.width - 150, doc.y).stroke();
            doc.moveDown(0.6);

            // Periode & tanggal (tanpa jam)
            doc.fontSize(10).font("Helvetica").fillColor("#666666")
               .text("Periode: " + targetDate + " s/d " + endDate, { align: "center" });
            doc.text("Dibuat: " + moment().format("DD MMMM YYYY"), { align: "center" });
            doc.moveDown(1.5);

            // === RANGKUMAN langsung di bawah ===
            doc.fontSize(13).font("Helvetica-Bold").fillColor("#1a1a1a")
               .text("RANGKUMAN");
            doc.moveDown(0.2);
            doc.strokeColor("#25D366").lineWidth(1.5)
               .moveTo(50, doc.y).lineTo(130, doc.y).stroke();
            doc.moveDown(0.8);

            // Render rangkuman
            var answerLines = cleanAnswer.split(NL);
            answerLines.forEach(function(line) {
                if (doc.y > doc.page.height - 70) doc.addPage();

                var trimmed = line.trim();
                if (!trimmed) {
                    doc.moveDown(0.5);
                    return;
                }

                // Deteksi heading (UPPERCASE pendek atau diawali angka)
                var isHeading = (/^[A-Z][A-Z\s&\/]{3,}:?$/.test(trimmed)) || (/^\d+\.\s*[A-Z]/.test(trimmed) && trimmed.length < 60);

                if (isHeading) {
                    doc.moveDown(0.4);
                    doc.fontSize(11).font("Helvetica-Bold").fillColor("#1a1a1a")
                       .text(trimmed, { width: pageWidth });
                    doc.moveDown(0.3);
                } else {
                    doc.fontSize(10).font("Helvetica").fillColor("#333333")
                       .text(trimmed, { width: pageWidth, lineGap: 2 });
                    doc.moveDown(0.15);
                }
            });

            // === DOKUMENTASI FOTO ===
            if (photos.length > 0) {
                doc.addPage();

                doc.fontSize(13).font("Helvetica-Bold").fillColor("#1a1a1a")
                   .text("DOKUMENTASI FOTO", 50, 50);
                doc.moveDown(0.2);
                doc.strokeColor("#25D366").lineWidth(1.5)
                   .moveTo(50, doc.y).lineTo(130, doc.y).stroke();
                doc.moveDown(0.3);
                doc.fontSize(9).font("Helvetica").fillColor("#666666")
                   .text(photos.length + " foto  |  " + (detectedGrup || "grup") + "  |  " + targetDate + " s/d " + endDate);
                doc.moveDown(1);

                var imgWidth = 230;
                var imgHeight = 170;
                var imgGap = 20;
                var startX = 55;
                var imgX = startX;
                var imgY = doc.y;
                var col = 0;

                photos.forEach(function(photo) {
                    try {
                        if (!fs.existsSync(photo.path)) return;

                        if (imgY + imgHeight + 25 > doc.page.height - 40) {
                            doc.addPage();
                            imgY = 50;
                            imgX = startX;
                            col = 0;
                        }

                        doc.roundedRect(imgX - 3, imgY - 3, imgWidth + 6, imgHeight + 6, 3)
                           .stroke("#e0e0e0");

                        doc.image(photo.path, imgX, imgY, { fit: [imgWidth, imgHeight], align: "center", valign: "center" });

                        doc.fontSize(7).font("Helvetica").fillColor("#999999")
                           .text(photo.date, imgX, imgY + imgHeight + 8, { width: imgWidth, align: "center" });

                        col++;
                        if (col >= 2) {
                            col = 0;
                            imgX = startX;
                            imgY += imgHeight + 32;
                        } else {
                            imgX += imgWidth + imgGap;
                        }
                    } catch (e) {}
                });
            }

            // === FOOTER: hanya nomor halaman (no new page trigger) ===
            var range = doc.bufferedPageRange();
            for (var i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                // Pakai absolute position supaya ga trigger new page
                doc.page.margins.bottom = 0;
                doc.fontSize(8).font("Helvetica").fillColor("#cccccc")
                   .text(String(i + 1), 50, doc.page.height - 25, { width: doc.page.width - 100, align: "center", lineBreak: false });
            }

            doc.end();

            stream.on("finish", function() { resolve(outputPath); });
            stream.on("error", function(err) { reject(err); });
        } catch (err) {
            reject(err);
        }
    });
}


// ==========================================
// GEMINI API HELPER (with retry for rate limit)
// ==========================================

async function callGemini(prompt) {
    var LLM_BASE_URL = process.env.LLM_BASE_URL;
    var LLM_API_KEY = process.env.LLM_API_KEY;
    var LLM_MODEL = process.env.LLM_MODEL;
    var LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL;

    if (!LLM_API_KEY || !LLM_BASE_URL) {
        throw new Error("LLM_BASE_URL atau LLM_API_KEY belum diset di .env");
    }

    var models = [LLM_MODEL, LLM_FALLBACK_MODEL].filter(Boolean);
    if (models.length === 0) throw new Error("LLM_MODEL belum diset di .env");

    var lastError = null;

    for (var m = 0; m < models.length; m++) {
        var apiUrl = LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions";
        var maxRetries = 2;
        var retryDelay = 5000;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                var response = await axios.post(apiUrl, {
                    model: models[m],
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.7
                }, {
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + LLM_API_KEY
                    },
                    timeout: 90000
                });

                var aiText = "";
                if (response.data.choices && response.data.choices[0] && response.data.choices[0].message) {
                    aiText = response.data.choices[0].message.content || "";
                }
                if (!aiText) throw new Error("LLM tidak mengembalikan hasil.");

                // TRACK SUCCESS
                geminiTracker.success++;
                geminiTracker.lastStatus = "OK";
                geminiTracker.lastUsed = moment().format("YYYY-MM-DD HH:mm:ss");
                geminiTracker.lastModel = models[m];
                geminiTracker.lastError = null;

                return aiText;

            } catch (err) {
                lastError = err;
                var statusCode = err.response ? err.response.status : 0;

                // TRACK FAILURE
                geminiTracker.failed++;
                geminiTracker.lastStatus = "ERROR " + statusCode;
                geminiTracker.lastUsed = moment().format("YYYY-MM-DD HH:mm:ss");
                geminiTracker.lastModel = models[m];
                geminiTracker.lastError = (err.message || "status " + statusCode).substring(0, 50);

                if ((statusCode === 429 || statusCode === 503) && attempt < maxRetries) {
                    console.log("LLM " + models[m] + " rate limited, retry in " + (retryDelay/1000) + "s...");
                    await new Promise(function(resolve) { setTimeout(resolve, retryDelay); });
                    retryDelay = retryDelay * 2;
                } else if (statusCode === 429 || statusCode === 503 || statusCode === 404) {
                    console.log("LLM " + models[m] + " failed (" + statusCode + "), trying next model...");
                    break; // try next model
                } else {
                    throw new Error("LLM API error: " + (err.response ? "status " + statusCode : err.message));
                }
            }
        }
    }
    throw new Error("Semua model LLM gagal. " + (lastError ? lastError.message : ""));
}


// ==========================================
// AI ASSISTANT - Jawab pertanyaan apapun
// ==========================================

async function askAIAssistant(question) {
    var NL = String.fromCharCode(10);
    if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL) throw new Error("LLM_BASE_URL atau LLM_API_KEY belum diset di .env");

    // Kumpulkan konteks data untuk AI
    var context = "";

    // 1. Daftar grup
    var mediaDir = path.join(__dirname, "WA-MEDIA");
    var grupList = [];
    if (fs.existsSync(mediaDir)) {
        grupList = fs.readdirSync(mediaDir).filter(function(item) {
            return fs.statSync(path.join(mediaDir, item)).isDirectory();
        });
    }
    context += "DAFTAR GRUP (" + grupList.length + "):" + NL;
    context += grupList.join(", ") + NL + NL;

    // 2. Statistik media
    var db = [];
    try { db = fs.readJsonSync(MEDIA_DB_FILE); } catch (e) {}
    var today = moment().format("YYYY-MM-DD");
    var todayMedia = db.filter(function(x) { return x.time && x.time.startsWith(today); });

    context += "STATISTIK MEDIA:" + NL;
    context += "- Total semua: " + db.length + " file" + NL;
    context += "- Hari ini: " + todayMedia.length + " file" + NL;
    context += "- Images: " + db.filter(function(x){return x.type==="images";}).length + NL;
    context += "- Videos: " + db.filter(function(x){return x.type==="videos";}).length + NL;
    context += "- Documents: " + db.filter(function(x){return x.type==="documents";}).length + NL + NL;

    // 3. Media 7 hari terakhir per grup
    context += "MEDIA 7 HARI TERAKHIR PER GRUP:" + NL;
    var last7days = moment().subtract(7, "days").format("YYYY-MM-DD");
    var recentByGrup = {};
    db.forEach(function(x) {
        if (x.time && x.time.slice(0, 10) >= last7days) {
            recentByGrup[x.group] = (recentByGrup[x.group] || 0) + 1;
        }
    });
    Object.keys(recentByGrup).forEach(function(g) {
        context += "- " + g + ": " + recentByGrup[g] + " file" + NL;
    });
    context += NL;

    // 4. Top senders minggu ini
    context += "TOP PENGIRIM 7 HARI:" + NL;
    var senderCount = {};
    db.forEach(function(x) {
        if (x.time && x.time.slice(0, 10) >= last7days) {
            var key = (x.sender || "Unknown") + " (" + (x.number || "") + ")";
            senderCount[key] = (senderCount[key] || 0) + 1;
        }
    });
    var topSenders = Object.entries(senderCount).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);
    topSenders.forEach(function(s) { context += "- " + s[0] + ": " + s[1] + " file" + NL; });
    context += NL;

    // 5. Error/failed terakhir
    var failed = [];
    try { failed = fs.readJsonSync(FAILED_FILE); } catch (e) {}
    context += "ERROR TERAKHIR (" + failed.length + " total):" + NL;
    failed.slice(0, 5).forEach(function(f) {
        context += "- [" + f.time + "] " + f.group + ": " + f.error + NL;
    });
    context += NL;

    // 6. Chat history - SMART LOADING
    // Deteksi apakah user tanya soal grup/tanggal tertentu
    var questionLower = question.toLowerCase();
    var targetGrup = null;
    var targetDate = null;

    // Cari nama grup di pertanyaan
    grupList.forEach(function(g) {
        if (questionLower.indexOf(g.toLowerCase()) !== -1) {
            targetGrup = g;
        }
        // Cek partial match (misal "bandung" cocok ke "Podomoro Park Bandung ")
        var words = g.toLowerCase().split(" ");
        words.forEach(function(w) {
            if (w.length > 4 && questionLower.indexOf(w) !== -1 && !targetGrup) {
                targetGrup = g;
            }
        });
    });

    // Deteksi tanggal dari pertanyaan
    if (questionLower.indexOf("hari ini") !== -1 || questionLower.indexOf("today") !== -1) {
        targetDate = moment().format("YYYY-MM-DD");
    } else if (questionLower.indexOf("kemarin") !== -1 || questionLower.indexOf("kemaren") !== -1 || questionLower.indexOf("yesterday") !== -1) {
        targetDate = moment().subtract(1, "days").format("YYYY-MM-DD");
    } else if (questionLower.indexOf("1 hari lalu") !== -1 || questionLower.indexOf("1hari lalu") !== -1) {
        targetDate = moment().subtract(1, "days").format("YYYY-MM-DD");
    } else if (questionLower.indexOf("2 hari lalu") !== -1 || questionLower.indexOf("2hari lalu") !== -1) {
        targetDate = moment().subtract(2, "days").format("YYYY-MM-DD");
    } else if (questionLower.indexOf("3 hari lalu") !== -1 || questionLower.indexOf("3hari lalu") !== -1) {
        targetDate = moment().subtract(3, "days").format("YYYY-MM-DD");
    } else if (questionLower.indexOf("minggu ini") !== -1) {
        targetDate = moment().subtract(7, "days").format("YYYY-MM-DD");
    }
    // Cek format tanggal eksplisit
    var dateMatch = question.match(/\d{4}-\d{2}-\d{2}/);
    if (dateMatch) targetDate = dateMatch[0];

    // Load chat berdasarkan konteks
    if (targetGrup) {
        // Load chat dari grup tertentu (max 100 pesan terbaru)
        var logFile = path.join(mediaDir, targetGrup, "chat_history.jsonl");
        if (fs.existsSync(logFile)) {
            try {
                var content = fs.readFileSync(logFile, "utf8").trim();
                if (content) {
                    var lines = content.split(String.fromCharCode(10));
                    var filteredChats = [];
                    // Baca dari belakang untuk hemat waktu
                    var startIdx = Math.max(0, lines.length - 500);
                    for (var li = startIdx; li < lines.length; li++) {
                        try {
                            if (!lines[li]) continue;
                            var chat = JSON.parse(lines[li]);
                            if (targetDate) {
                                var chatDate = (chat.time || "").slice(0, 10);
                                if (chatDate >= targetDate && chatDate <= moment().format("YYYY-MM-DD")) {
                                    filteredChats.push(chat);
                                }
                            } else {
                                filteredChats.push(chat);
                            }
                        } catch (e) {}
                    }

                    // Ambil max 100 pesan terbaru
                    var chatSlice = filteredChats.slice(-100);
                    context += "CHAT GRUP " + targetGrup + (targetDate ? " (dari " + targetDate + ")" : " (terbaru)") + " - " + chatSlice.length + " pesan:" + NL;
                    chatSlice.forEach(function(c) {
                        context += "[" + c.time + "] " + c.sender + ": " + c.message + NL;
                    });
                }
            } catch (e) {
                context += "CHAT GRUP " + targetGrup + ": gagal membaca (" + e.message + ")" + NL;
            }
        } else {
            context += "CHAT GRUP " + targetGrup + ": belum ada riwayat chat." + NL;
        }
    } else {
        // Tidak sebut grup spesifik - ambil 30 terbaru dari semua grup (hemat konteks)
        context += "CHAT TERBARU (semua grup):" + NL;
        var allChats = [];
        grupList.forEach(function(g) {
            var logFile = path.join(mediaDir, g, "chat_history.jsonl");
            if (fs.existsSync(logFile)) {
                try {
                    var content = fs.readFileSync(logFile, "utf8").trim();
                    if (!content) return;
                    var lines = content.split(String.fromCharCode(10));
                    var recent = lines.slice(-8);
                    recent.forEach(function(line) {
                        if (!line) return;
                        try {
                            var chat = JSON.parse(line);
                            chat._grup = g;
                            allChats.push(chat);
                        } catch (e) {}
                    });
                } catch (e) {}
            }
        });
        allChats.sort(function(a, b) { return (b.time || "").localeCompare(a.time || ""); });
        allChats.slice(0, 30).forEach(function(c) {
            context += "[" + c.time + "] [" + c._grup + "] " + c.sender + ": " + c.message + NL;
        });
    }
    context += NL;

    // Batasi context supaya API tidak terlalu lama
    if (context.length > 12000) {
        context = context.substring(context.length - 12000);
    }

    // 7. Status bot
    var botStatus = { connected: false };
    try { botStatus = fs.readJsonSync(STATUS_FILE); } catch (e) {}
    var stats = loadStats();

    // Prompt
    var prompt = "Kamu membantu membuat laporan dari chat WhatsApp grup." + NL;
    prompt += "Tulis dengan bahasa Indonesia yang natural seperti orang biasa menulis email laporan." + NL;
    prompt += "JANGAN awali dengan 'Tentu', 'Baik', 'Berikut'. Langsung ke isi." + NL;
    prompt += "JANGAN pakai format markdown. Tulis plain text." + NL;
    prompt += "JANGAN sebutkan jam/pukul per pesan. Cukup rangkum per topik." + NL;
    prompt += "Tulis ringkas tapi informatif — seperti laporan singkat ke atasan." + NL + NL;
    prompt += "STATUS BOT: " + (botStatus.connected ? "Online" : "Offline") + NL;
    prompt += "TOTAL SAVED: " + stats.saved + " | TOTAL FAILED: " + stats.failed + NL + NL;
    prompt += "=== DATA KONTEKS ===" + NL;
    prompt += context + NL + NL;
    prompt += "=== PERTANYAAN USER ===" + NL;
    prompt += question;

    // Panggil Gemini
    var aiText = await callGemini(prompt);
    if (!aiText) throw new Error("AI tidak merespon");

    // Format output
    var output = "";
    output += "━━━━━━━━━━━━━━━━━━━━" + NL;
    output += "🧠 *AI ASSISTANT*" + NL;
    output += "━━━━━━━━━━━━━━━━━━━━" + NL + NL;
    output += "❓ _" + question + "_" + NL + NL;
    output += aiText + NL + NL;
    output += "━━━━━━━━━━━━━━━━━━━━";

    return output;
}


// ==========================================
// START BOT + SCHEDULER
// ==========================================

start();
setInterval(telegramCommands, 3000);
scheduleDailySummary();

console.log("Bot started. Daily summary scheduled at 23:00.");
