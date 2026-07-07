require("dotenv").config();
const QRCode = require("qrcode");
const express = require("express");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(express.json()); // Supaya dashboard bisa membaca body berformat JSON
app.use("/media", express.static(path.join(__dirname, "WA-MEDIA")));
const PORT = 3002;

const MEDIA_DIR = path.join(__dirname, "WA-MEDIA");
const STATUS_FILE = path.join(__dirname, "status.json");
const FAILED_FILE = path.join(__dirname, "failed-media.json");
const PINNED_FILE = path.join(__dirname, "pinned-groups.json");

// Array client aktif untuk menyalurkan notifikasi Live Toast SSE
let sseClients = [];

function sendLiveToastToBrowsers(data) {
  var LF = String.fromCharCode(10);
  sseClients.forEach(client => client.res.write("data: " + JSON.stringify(data) + LF + LF));
}

let lastSentMessageId = null;

// Watcher asinkron untuk memantau database media-db.json secara real-time
fs.watch(path.join(__dirname, "media-db.json"), (eventType) => {
  if (eventType === 'change') {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(__dirname, "media-db.json"), "utf8"));
      if(db.length > 0) {
        const latestMedia = db[db.length - 1];
        const currentMediaKey = latestMedia.messageId || latestMedia.file;
        if (currentMediaKey !== lastSentMessageId) {
          lastSentMessageId = currentMediaKey;
          sendLiveToastToBrowsers(latestMedia);
        }
      }
    } catch(e){}
  }
});

// Fungsi pembantu membaca & menyimpan grup yang di-pin
function loadPinnedGroups() {
  try { if (fs.existsSync(PINNED_FILE)) return JSON.parse(fs.readFileSync(PINNED_FILE, "utf8")); } catch {}
  return [];
}
function savePinnedGroups(pinned) {
  fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2), "utf8");
}

async function scanDir(dir) {
  let images = 0; let videos = 0; let documents = 0;
  let groups = new Set(); let latestFiles = [];

  async function walk(folder) {
    try { await fsPromises.access(folder); } catch { return; }
    const items = await fsPromises.readdir(folder, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) {
        const rel = path.relative(MEDIA_DIR, fullPath);
        const parts = rel.split(path.sep);
        if (parts.length >= 1) groups.add(parts[0]);
        await walk(fullPath);
      } else {
        const ext = path.extname(item.name).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) images++;
        else if ([".mp4", ".mov", ".mkv", ".opus", ".mp3", ".wav"].includes(ext)) videos++;
        else documents++;

        const stat = await fsPromises.stat(fullPath);
        latestFiles.push({ name: item.name, path: fullPath, time: stat.mtimeMs });
      }
    }
  }
  await walk(dir);
  latestFiles.sort((a, b) => b.time - a.time);
  return { images, videos, documents, groups: groups.size, latestFiles: latestFiles.slice(0, 20) };
}

function searchMediaDB(keyword) {
  if (!keyword) return [];
  let db = [];
  try { db = JSON.parse(fs.readFileSync(path.join(__dirname, "media-db.json"), "utf8")); } catch (err) { return []; }
  keyword = keyword.toLowerCase();
  return db.filter(x => (x.sender || "").toLowerCase().includes(keyword) || (x.number || "").toLowerCase().includes(keyword) || (x.group || "").toLowerCase().includes(keyword)).slice(0, 100);
}

function getSenderMediaCount(number) {
  if(!number || number === 'unknown') return 0;
  let db = [];
  try { db = JSON.parse(fs.readFileSync(path.join(__dirname, "media-db.json"), "utf8")); } catch { return 0; }
  return db.filter(x => x.number === number).length;
}

async function getFolderSize(dir) {
  let size = 0;
  async function walk(folder) {
    try { await fsPromises.access(folder); } catch { return; }
    const items = await fsPromises.readdir(folder, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) await walk(fullPath);
      else {
        if (item.name === "chat_history.jsonl") continue;
        const stat = await fsPromises.stat(fullPath);
        size += stat.size;
      }
    }
  }
  await walk(dir);
  return (size / 1024 / 1024 / 1024).toFixed(2);
}

async function getGroups() {
  try {
    await fsPromises.access(MEDIA_DIR);
    const items = await fsPromises.readdir(MEDIA_DIR, { withFileTypes: true });
    const allGroups = items.filter(item => item.isDirectory()).map(item => item.name);
    
    const pinned = loadPinnedGroups();
    const pinnedPart = allGroups.filter(g => pinned.includes(g)).sort();
    const unpinnedPart = allGroups.filter(g => !pinned.includes(g)).sort();
    
    return [...pinnedPart, ...unpinnedPart];
  } catch { return []; }
}

async function getGroupMedia(groupName, page = 1, limit = 40, targetDate = null) {
  const files = []; const groupDir = path.join(MEDIA_DIR, groupName);
  async function walk(dir) {
    try { await fsPromises.access(dir); } catch { return; }
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else { 
        if (item.name === "chat_history.jsonl") continue; 
        const stat = await fsPromises.stat(full); 
        if (targetDate) {
          const fileDateStr = new Date(stat.mtime).toISOString().slice(0, 10);
          if (fileDateStr !== targetDate) continue;
        }
        files.push({ name: item.name, path: full, time: stat.mtimeMs }); 
      }
    }
  }
  await walk(groupDir);
  files.sort((a, b) => b.time - a.time);
  const startIndex = (page - 1) * limit; const endIndex = page * limit;
  return { data: files.slice(startIndex, endIndex), hasMore: endIndex < files.length };
}

async function getAllMedia() {
  const files = [];
  async function walk(dir) {
    try { await fsPromises.access(dir); } catch { return; }
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else { if(item.name !== "chat_history.jsonl") { const stat = await fsPromises.stat(full); files.push({ name: item.name, path: full, time: stat.mtimeMs }); } }
    }
  }
  await walk(MEDIA_DIR); files.sort((a, b) => b.time - a.time); return files;
}

function getGroupStats(files) {
  let images = 0; let videos = 0; let documents = 0;
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) images++;
    else if ([".mp4", ".mov", ".mkv", ".opus", ".mp3", ".wav"].includes(ext)) videos++; else documents++;
  }
  return { images, videos, documents };
}

async function getTodayStats() {
  let images = 0; let videos = 0; let documents = 0; const today = new Date().toDateString();
  async function walk(dir) {
    try { await fsPromises.access(dir); } catch { return; }
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else {
        if (item.name === "chat_history.jsonl") continue;
        const stat = await fsPromises.stat(full); if (new Date(stat.mtime).toDateString() !== today) continue;
        const ext = path.extname(item.name).toLowerCase();
        if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) images++;
        else if ([".mp4", ".mov", ".mkv", ".opus", ".mp3", ".wav"].includes(ext)) videos++; else documents++;
      }
    }
  }
  await walk(MEDIA_DIR); return { images, videos, documents };
}

async function getActivity7Days() {
  const result = {}; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); result[d.toISOString().slice(0, 10)] = 0; }
  async function walk(dir) {
    try { await fsPromises.access(dir); } catch { return; }
    const items = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) await walk(full);
      else { if(item.name !== "chat_history.jsonl") { const stat = await fsPromises.stat(full); const day = new Date(stat.mtime).toISOString().slice(0, 10); if (result[day] !== undefined) result[day]++; } }
    }
  }
  await walk(MEDIA_DIR); return result;
}

function helperFormatCardData(f, relativeDir, mediaDirRoot) {
  const relPath = path.relative(mediaDirRoot, f.path).split("\\").join("/"); 
  const ext = path.extname(f.name).toLowerCase();
  
  let fileSize = '-- MB'; 
  let formattedTime = '--:--';
  let sender = 'Sistem';
  let senderNum = 'unknown';

  try { 
    const stat = fs.statSync(f.path);
    fileSize = (stat.size / 1024 / 1024).toFixed(1) + ' MB'; 
    formattedTime = new Date(stat.mtime).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  } catch{}

  const parts = f.name.split('_');
  if (parts.length >= 2) senderNum = parts[1];
  if (parts.length >= 3) sender = parts[2];

  let mediaType = 'doc';
  let isPlayable = false;
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) { mediaType = 'image'; isPlayable = true; }
  else if ([".mp4", ".mov", ".mkv"].includes(ext)) { mediaType = 'video'; isPlayable = true; }
  else if ([".mp3", ".opus", ".wav"].includes(ext)) { mediaType = 'audio'; isPlayable = true; }

  const totalShared = getSenderMediaCount(senderNum);

  return {
    name: f.name,
    src: `/media/${relPath}`,
    size: fileSize,
    time: formattedTime,
    sender: sender,
    number: senderNum,
    type: mediaType,
    isPlayable: isPlayable,
    ext: ext,
    totalMediaContributed: totalShared
  };
}

// Endpoint SSE Event Stream
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const id = Date.now();
  sseClients.push({ id, res });
  req.on("close", () => { sseClients = sseClients.filter(c => c.id !== id); });
});

app.get("/api/media", async (req, res) => {
  const group = req.query.group || ""; const page = parseInt(req.query.page) || 1; const type = req.query.type || "all";
  const date = req.query.date || null;
  if (!group) return res.json({ data: [], hasMore: false });

  // Get ALL files for this group (with date filter), then filter by type, then paginate
  let allResult = await getGroupMedia(group, 1, 99999, date);
  let allFiles = allResult.data;

  if (type !== "all") {
    allFiles = allFiles.filter((f) => {
      const ext = path.extname(f.name).toLowerCase();
      if (type === "images") return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
      if (type === "videos") return [".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
      return ![".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
    });
  }

  // Manual pagination after filter
  const limit = 40;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  const gallery = allFiles.slice(startIndex, endIndex);
  const hasMore = endIndex < allFiles.length;

  const formattedData = gallery.map(f => helperFormatCardData(f, group, MEDIA_DIR));
  res.json({ data: formattedData, hasMore });
});

// API pin & unpin grup WhatsApp di sidebar
app.post("/api/pin-group", (req, res) => {
  const { group, pin } = req.body;
  if (!group) return res.status(400).json({ error: "Nama grup kosong" });
  
  let pinned = loadPinnedGroups();
  if (pin) {
    if (!pinned.includes(group)) pinned.push(group);
  } else {
    pinned = pinned.filter(g => g !== group);
  }
  savePinnedGroups(pinned);
  res.json({ success: true, pinned });
});

// Request unduh ulang - simpan ke queue file
app.post("/api/redownload", (req, res) => {
  const { messageId } = req.body;
  if(!messageId) return res.status(400).json({ error: "Message ID wajib diisi" });

  try {
    // Simpan ke redownload-queue.json
    const queueFile = path.join(__dirname, "redownload-queue.json");
    let queue = [];
    try { if(fs.existsSync(queueFile)) queue = JSON.parse(fs.readFileSync(queueFile, "utf8")); } catch(e) { queue = []; }
    queue.push({ messageId: messageId, requestedAt: new Date().toISOString() });
    fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

    // Hapus dari failed-media.json
    try {
      if (fs.existsSync(FAILED_FILE)) {
        let failedList = JSON.parse(fs.readFileSync(FAILED_FILE, "utf8"));
        failedList = failedList.filter(f => f.messageId !== messageId);
        fs.writeFileSync(FAILED_FILE, JSON.stringify(failedList, null, 2), "utf8");
      }
    } catch(e) {}

    // Kirim ke Telegram jika ada config
    const botToken = process.env.BOT_TOKEN;
    const chatId = process.env.CHAT_ID;
    if(botToken && chatId) {
      try {
        require("axios").post("https://api.telegram.org/bot" + botToken + "/sendMessage", {
          chat_id: chatId,
          text: "/redownload " + messageId
        });
      } catch(e) {}
    }

    return res.json({ success: true, message: "Media telah ditambahkan ke antrian unduh ulang." });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// API Blacklist/Whitelist Grup
app.get("/api/ignored-groups", (req, res) => {
  try {
    const IGNORED_FILE = path.join(__dirname, "ignored-groups.json");
    let ignored = [];
    if (fs.existsSync(IGNORED_FILE)) {
      ignored = JSON.parse(fs.readFileSync(IGNORED_FILE, "utf8"));
    }
    res.json({ groups: ignored });
  } catch (e) { res.json({ groups: [] }); }
});

app.post("/api/ignore-group", (req, res) => {
  const { group, ignore } = req.body;
  if (!group) return res.status(400).json({ error: "Nama grup kosong" });

  const IGNORED_FILE = path.join(__dirname, "ignored-groups.json");
  let ignored = [];
  try { if (fs.existsSync(IGNORED_FILE)) ignored = JSON.parse(fs.readFileSync(IGNORED_FILE, "utf8")); } catch {}

  if (ignore) {
    if (!ignored.includes(group)) ignored.push(group);
  } else {
    ignored = ignored.filter(function(g) { return g !== group; });
  }
  fs.writeFileSync(IGNORED_FILE, JSON.stringify(ignored, null, 2));
  res.json({ success: true, ignored: ignored });
});

app.get("/api/export-chat", async (req, res) => {
  const group = (req.query.group || "").trim();
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  if (!group) return res.status(400).send("Nama grup tidak boleh kosong");

  const logFile = path.join(MEDIA_DIR, group, "chat_history.jsonl");

  try {
    await fsPromises.access(logFile);
    const fileContent = await fsPromises.readFile(logFile, "utf8");
    const lines = fileContent.trim().split(String.fromCharCode(10));

    var NL = String.fromCharCode(10);
    let textOutput = "==================================================" + NL;
    textOutput += " ARSIP CHAT GRUP: " + group.toUpperCase() + NL;
    if (startDate) textOutput += " Rentang Filter: " + startDate + " s/d " + (endDate || startDate) + NL;
    textOutput += " Diunduh pada: " + new Date().toLocaleString('id-ID') + NL;
    textOutput += "==================================================" + NL + NL;

    lines.forEach(line => {
      if (!line) return;
      try {
        const chat = JSON.parse(line);
        const chatDayStr = chat.time.slice(0, 10);
        if (startDate) {
          if (chatDayStr < startDate) return;
          if (endDate && chatDayStr > endDate) return;
        }
        textOutput += "[" + chat.time + "] " + chat.sender + " (" + chat.number + "): " + chat.message + NL;
      } catch (e) {}
    });

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="CHAT_LOG_${group.replace(/\s+/g, '_')}.txt"`);
    res.send(textOutput);
  } catch (err) {
    res.status(404).send("<h2>📭 Belum ada riwayat chat tercatat untuk grup ini.</h2><br><a href='/'>Kembali</a>");
  }
});

app.get("/", async (req, res) => {
  const keyword = (req.query.search || "").toLowerCase().trim();
  const targetDate = req.query.date || null;
  const groups = await getGroups(); const selectedGroup = req.query.group || groups[0] || "";
  const pinnedList = loadPinnedGroups();
  let groupStats = { images: 0, videos: 0, documents: 0 }; let gallery = []; let hasMore = false;

  if (selectedGroup) {
    const result = await getGroupMedia(selectedGroup, 1, 40, targetDate); gallery = result.data; hasMore = result.hasMore;
    const allGroupData = await getGroupMedia(selectedGroup, 1, 99999, targetDate); groupStats = getGroupStats(allGroupData.data);
  }

  const search = (req.query.search || "").toLowerCase(); const type = req.query.type || "all";
  if (type !== "all") {
    gallery = gallery.filter((f) => {
      const ext = path.extname(f.name).toLowerCase();
      if (type === "images") return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
      if (type === "videos") return [".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
      return ![".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
    });
  }

  if (search) { const allMedia = await getAllMedia(); gallery = allMedia.filter((f) => f.name.toLowerCase().includes(search)); }

  // Sort gallery based on sort parameter
  const sortBy = req.query.sort || "newest";
  if (sortBy === "oldest") { gallery.sort((a, b) => a.time - b.time); }
  else if (sortBy === "largest") { gallery.sort((a, b) => { try { return fs.statSync(b.path).size - fs.statSync(a.path).size; } catch { return 0; } }); }
  else if (sortBy === "smallest") { gallery.sort((a, b) => { try { return fs.statSync(a.path).size - fs.statSync(b.path).size; } catch { return 0; } }); }
  else if (sortBy === "name") { gallery.sort((a, b) => a.name.localeCompare(b.name)); }
  // default "newest" is already sorted by time desc

  const stats = await scanDir(MEDIA_DIR); const storage = await getFolderSize(MEDIA_DIR); const dbResults = searchMediaDB(keyword);
  let statsCounter = { saved: 0, failed: 0 }; try { statsCounter = JSON.parse(fs.readFileSync(path.join(__dirname, "stats.json"), "utf8")); } catch {}

  // Membaca list berkas log error terakhir untuk ditampilkan di modal dashboard
  let failedList = []; try { if(fs.existsSync(FAILED_FILE)) failedList = JSON.parse(fs.readFileSync(FAILED_FILE, "utf8")).slice(0, 15); } catch(e){}

  const todayStats = await getTodayStats(); const activity7Days = await getActivity7Days();
  let waStatus = "🔴 OFFLINE"; let qrImage = ""; 
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    waStatus = status.connected ? "🟢 ONLINE" : "🔴 OFFLINE";
    if (status.qr) qrImage = await QRCode.toDataURL(status.qr);
  } catch {}

  res.send(`
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WA MEDIA DASHBOARD</title>
<style>
:root {
  --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d; --bg-hover: #30363d; --border: #30363d;
  --text-primary: #e6edf3; --text-secondary: #8b949e; --text-muted: #6e7681; --accent-green: #25D366; --accent-blue: #58a6ff;
  --accent-red: #f85149; --accent-orange: #d29922; --accent-purple: #bc8cff; --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px; --shadow: 0 8px 24px rgba(0,0,0,0.4);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif; background: var(--bg-primary); color: var(--text-primary); line-height: 1.6; min-height: 100vh; }
.header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
.header-left { display: flex; align-items: center; gap: 16px; }
.header h1 { font-size: 1.4rem; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 10px; }
.status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; }
.status-badge.online { background: rgba(37, 211, 102, 0.15); color: var(--accent-green); border: 1px solid rgba(37, 211, 102, 0.3); }
.status-badge.offline { background: rgba(248, 81, 73, 0.15); color: var(--accent-red); border: 1px solid rgba(248, 81, 73, 0.3); }
.status-dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 2s infinite; }
.status-badge.online .status-dot { background: var(--accent-green); }
.status-badge.offline .status-dot { background: var(--accent-red); animation: none; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.header-actions { display: flex; gap: 10px; }
.btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: var(--radius-sm); font-size: 0.9rem; font-weight: 600; text-decoration: none; border: none; cursor: pointer; transition: all 0.2s ease; }
.btn-primary { background: var(--accent-blue); color: #fff; }
.btn-danger { background: var(--accent-red); color: #fff; }
.btn-warning { background: var(--accent-orange); color: #fff; }
.btn-ghost { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }
.btn-ghost:hover { background: var(--bg-hover); }
.btn-sm { padding: 6px 12px; font-size: 0.8rem; }
.layout { display: grid; grid-template-columns: 280px 1fr; gap: 24px; padding: 24px; max-width: 1600px; margin: 0 auto; }
.sidebar { display: flex; flex-direction: column; gap: 20px; }
.card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; }
.card-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 16px; }
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.stat-item { background: var(--bg-tertiary); border-radius: var(--radius-md); padding: 16px; text-align: center; border: 1px solid var(--border); }
.stat-value { font-size: 1.8rem; font-weight: 700; color: var(--text-primary); }
.stat-label { font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px; }
.stat-item.highlight .stat-value { color: var(--accent-green); }
.stat-item.highlight-blue .stat-value { color: var(--accent-blue); }
.stat-item.highlight-orange .stat-value { color: var(--accent-orange); }
.success-rate { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
.success-bar-bg { height: 8px; background: var(--bg-tertiary); border-radius: 4px; overflow: hidden; margin-top: 8px; }
.success-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent-green), #16a34a); border-radius: 4px; }
.activity-chart { display: flex; align-items: flex-end; gap: 8px; height: 120px; padding-top: 20px; }
.activity-bar-wrapper { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; justify-content: flex-end; }
.activity-bar { width: 100%; max-width: 36px; background: linear-gradient(180deg, var(--accent-green), rgba(37, 211, 102, 0.3)); border-radius: 4px 4px 0 0; min-height: 4px; }
.activity-label { font-size: 0.65rem; color: var(--text-muted); }
.activity-count { font-size: 0.7rem; color: var(--text-secondary); font-weight: 600; }
.group-list { display: flex; flex-direction: column; gap: 4px; max-height: 400px; overflow-y: auto; }

.group-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: var(--radius-sm); text-decoration: none; color: var(--text-primary); font-size: 0.9rem; border: 1px solid transparent; }
.group-item:hover { background: var(--bg-tertiary); }
.group-item.active { background: rgba(37, 211, 102, 0.1); border-color: rgba(37, 211, 102, 0.3); color: var(--accent-green); }
.group-main-clickable { display: flex; align-items: center; gap: 10px; overflow: hidden; flex: 1; text-decoration: none; color: inherit; }
.btn-pin { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 2px 6px; color: var(--text-muted); transition: color 0.2s, transform 0.2s; opacity: 0.3; }
.group-item:hover .btn-pin, .btn-pin.pinned { opacity: 1; }
.btn-pin.pinned { color: var(--accent-orange); transform: rotate(45deg); }

.group-avatar { width: 32px; height: 32px; border-radius: 50%; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; shrink: 0; }
.main-content { display: flex; flex-direction: column; gap: 20px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.search-box { flex: 1; min-width: 200px; position: relative; }
.search-box input { width: 100%; padding: 10px 16px 10px 40px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); outline: none; }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-muted); }
.filter-tabs { display: flex; gap: 4px; background: var(--bg-tertiary); padding: 4px; border-radius: var(--radius-sm); }
.filter-tab { padding: 8px 16px; border-radius: 4px; text-decoration: none; color: var(--text-secondary); font-size: 0.85rem; }
.filter-tab.active { background: var(--bg-secondary); color: var(--text-primary); }
.group-stats { display: flex; gap: 20px; padding: 12px 16px; background: var(--bg-tertiary); border-radius: var(--radius-md); font-size: 0.85rem; }

.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
.gallery-item { display: flex; flex-direction: column; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; cursor: pointer; transition: transform 0.2s, border-color 0.2s; position: relative; }
.gallery-item:hover { transform: translateY(-3px); border-color: var(--accent-blue); }
.media-preview { width: 100%; height: 150px; background: var(--bg-tertiary); display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; }
.media-preview img { width: 100%; height: 100%; object-fit: cover; }
.media-preview .icon-placeholder { font-size: 3rem; }
.card-info { padding: 10px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--border); position: relative; }
.card-filename { font-size: 0.75rem; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.card-row-details { display: flex; justify-content: space-between; align-items: center; font-size: 0.68rem; color: var(--text-secondary); }
.badge-type { padding: 2px 6px; border-radius: 4px; font-size: 0.6rem; font-weight: bold; text-transform: uppercase; }
.badge-image { background: rgba(37, 211, 102, 0.15); color: var(--accent-green); }
.badge-video { background: rgba(88, 166, 255, 0.15); color: var(--accent-blue); }
.badge-audio { background: rgba(188, 140, 255, 0.15); color: var(--accent-purple); }
.badge-doc { background: rgba(210, 153, 34, 0.15); color: var(--accent-orange); }

.hover-sender-container { position: relative; display: inline-block; cursor: help; }
.sender-hover-card { display: none; position: absolute; bottom: 125%; left: 50%; transform: translateX(-50%); width: 180px; background: #21262d; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px; box-shadow: var(--shadow); z-index: 1000; text-align: center; }
.hover-sender-container:hover .sender-hover-card { display: block; }
.sender-hover-card::after { content: ""; position: absolute; top: 100%; left: 50%; margin-left: -6px; border-width: 6px; border-style: solid; border-color: #21262d transparent transparent transparent; }
.hover-card-avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--bg-hover); margin: 0 auto 8px; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; border: 1px solid var(--border); }
.hover-card-name { font-size: 0.78rem; font-weight: bold; color: #fff; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hover-card-num { font-size: 0.65rem; color: var(--text-muted); margin-bottom: 6px; }
.hover-card-count { font-size: 0.7rem; color: var(--accent-green); font-weight: 600; background: rgba(37,211,102,0.1); padding: 2px 6px; border-radius: 4px; display: inline-block; }

.lightbox { display: none; position: fixed; z-index: 9999; inset: 0; background: rgba(13, 17, 23, 0.96); justify-content: center; align-items: center; flex-direction: column; backdrop-filter: blur(8px); }
.lightbox.active { display: flex; }
.lightbox-content { max-width: 90%; max-height: 75vh; display: flex; align-items: center; justify-content: center; }
.lightbox-content img, .lightbox-content video { max-width: 100%; max-height: 75vh; border-radius: var(--radius-md); box-shadow: var(--shadow); }
.lightbox-content audio { width: 100%; min-width: 320px; max-width: 500px; }
.lightbox-info { margin-top: 16px; color: var(--text-primary); font-size: 0.85rem; font-weight: 500; max-width: 80%; text-align: center; word-break: break-all; }
.lightbox-nav { display: flex; gap: 16px; margin-top: 20px; }
.lightbox-nav button { padding: 10px 24px; background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); cursor: pointer; font-size: 1rem; transition: background 0.2s; }
.lightbox-nav button:hover { background: var(--bg-hover); }
.lightbox-close { position: absolute; top: 20px; right: 20px; width: 44px; height: 44px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 50%; color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; }

.spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.2); border-radius: 50%; border-top-color: var(--text-primary); animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
.empty-state { text-align: center; padding: 60px 20px; color: var(--text-muted); font-size: 3rem; }

.btn-top { display: none; position: fixed; bottom: 24px; right: 24px; width: 48px; height: 48px; border-radius: 50%; background: var(--accent-blue); color: #fff; font-size: 1.3rem; border: none; cursor: pointer; box-shadow: var(--shadow); z-index: 5000; align-items: center; justify-content: center; transition: background 0.2s; }
.btn-top:hover { background: #478cdb; }

.toast-container { position: fixed; bottom: 24px; left: 24px; display: flex; flex-direction: column; gap: 10px; z-index: 99999; }
.toast-item { background: var(--bg-secondary); border-left: 4px solid var(--accent-green); border-top: 1px solid var(--border); border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); width: 280px; padding: 14px; border-radius: 4px; box-shadow: var(--shadow); color: var(--text-primary); animation: slideIn 0.3s ease-out forwards; }
@keyframes slideIn { from { transform: translateX(-120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
.toast-header { display: flex; justify-content: space-between; font-weight: bold; font-size: 0.8rem; margin-bottom: 4px; color: var(--accent-green); }
.toast-body { font-size: 0.75rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.failed-log-section { margin-top: 20px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 20px; }
.failed-log-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 10px; text-align: left; }
.failed-log-table th { padding: 10px; color: var(--text-muted); border-bottom: 2px solid var(--border); }
.failed-log-table td { padding: 10px; border-bottom: 1px solid var(--border); color: var(--text-secondary); vertical-align: middle; }

@media (max-width: 768px) { .layout { grid-template-columns: 1fr; padding: 12px; } .sidebar { order: 2; } .main-content { order: 1; } .stats-grid { grid-template-columns: repeat(4, 1fr); gap: 8px; } .gallery { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); } .header { flex-wrap: wrap; gap: 10px; padding: 12px 16px; } .header-actions { flex-wrap: wrap; gap: 6px; } .toolbar { flex-direction: column; align-items: stretch; } .filter-tabs { overflow-x: auto; } .group-stats { flex-wrap: wrap; gap: 10px; } }

/* LIVE ACTIVITY FEED */
.feed-item { display:flex; align-items:flex-start; gap:8px; padding:6px 8px; border-radius:6px; background:var(--bg-tertiary); border:1px solid var(--border); animation:feedSlideIn 0.3s ease; }
@keyframes feedSlideIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }
.feed-dot { width:8px; height:8px; border-radius:50%; background:var(--accent-green); margin-top:4px; flex-shrink:0; animation:feedPulse 2s infinite; }
@keyframes feedPulse { 0%,100%{opacity:1;} 50%{opacity:0.4;} }
.feed-content { flex:1; line-height:1.4; }
.feed-sender { font-weight:600; color:var(--accent-blue); }
.feed-time { font-size:0.65rem; color:var(--text-muted); }

/* QUICK FILTER CHIPS */
.chip-sender { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:12px; background:rgba(88,166,255,0.1); border:1px solid rgba(88,166,255,0.3); color:var(--accent-blue); font-size:0.68rem; cursor:pointer; transition:all 0.2s; text-decoration:none; }
.chip-sender:hover { background:rgba(88,166,255,0.25); transform:scale(1.05); }

/* DARK/LIGHT THEME SUPPORT */
body.light-theme { --bg-primary: #ffffff; --bg-secondary: #f6f8fa; --bg-tertiary: #f0f2f5; --bg-hover: #e8eaed; --border: #d0d7de; --text-primary: #1f2328; --text-secondary: #656d76; --text-muted: #8b949e; --accent-green: #1a7f37; --accent-blue: #0969da; --accent-red: #cf222e; --accent-orange: #9a6700; --accent-purple: #8250df; --shadow: 0 4px 12px rgba(0,0,0,0.1); }
.theme-toggle { position: fixed; bottom: 24px; left: 24px; width: 44px; height: 44px; border-radius: 50%; background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; z-index: 5000; box-shadow: var(--shadow); }
.theme-toggle:hover { background: var(--bg-hover); }
</style>
</head>
<body>

<header class="header">
  <div class="header-left">
    <h1><span>📱</span> WA MEDIA DASHBOARD</h1>
    <span class="status-badge ${waStatus.includes('ONLINE') ? 'online' : 'offline'}">
      <span class="status-dot"></span><span class="status-text">${waStatus.includes('ONLINE') ? 'ONLINE' : 'OFFLINE'}</span>
    </span>
  </div>
  <div class="header-actions">
    <a href="/report" class="btn btn-ghost btn-sm">📋 Report</a>
    <a href="/blacklist" class="btn btn-ghost btn-sm">🚫 Blacklist</a>
    <a href="/antidelete" class="btn btn-ghost btn-sm">🗑 Anti-Delete</a>
    <a href="/restart-bot" class="btn btn-danger btn-sm">🔄 Restart</a>
    <a href="/logout-wa" class="btn btn-warning btn-sm">🚪 Logout WA</a>
  </div>
</header>

<div id="toastContainer" class="toast-container"></div>
<button id="btnTop" class="btn-top" onclick="scrollToTop()">⬆️</button>
<button class="theme-toggle" onclick="toggleTheme()" title="Toggle Dark/Light">🌓</button>

<div id="lightbox" class="lightbox" onclick="closeLightbox()">
  <button class="lightbox-close" onclick="closeLightbox()">✕</button>
  <div class="lightbox-content" onclick="event.stopPropagation()">
    <img id="lightboxImg" style="display: none;">
    <video id="lightboxVideo" controls style="display: none;"></video>
    <audio id="lightboxAudio" style="display: none;" controls></audio>
  </div>
  <div class="lightbox-info" id="lightboxInfo"></div>
  <div class="lightbox-nav">
    <button onclick="event.stopPropagation(); prevImage()">⬅️</button>
    <button onclick="event.stopPropagation(); nextImage()">➡️</button>
  </div>
</div>

<div class="layout">
  <aside class="sidebar">
    <div class="card">
      <div class="card-title">📊 Statistik Global</div>
      <div class="stats-grid">
        <div class="stat-item highlight"><div class="stat-value">${stats.images}</div><div class="stat-label">📷 Gambar</div></div>
        <div class="stat-item highlight-blue"><div class="stat-value">${stats.videos}</div><div class="stat-label">🎥 Video/Audio</div></div>
        <div class="stat-item highlight-orange"><div class="stat-value">${stats.documents}</div><div class="stat-label">📄 Dokumen</div></div>
        <div class="stat-item"><div class="stat-value">${stats.groups}</div><div class="stat-label">👥 Grup</div></div>
      </div>
      <div class="success-rate">
        <div style="display:flex; justify-content:space-between; font-size:0.85rem;"><span>💾 Storage</span><strong>${storage} GB</strong></div>
        <div style="display:flex; justify-content:space-between; font-size:0.85rem; margin-top:8px;"><span>📥 Saved / ❌ Failed</span><span><strong>${statsCounter.saved}</strong> / <strong style="color:var(--accent-red)">${statsCounter.failed}</strong></span></div>
        <div class="success-bar-bg"><div class="success-bar-fill" style="width:${(statsCounter.saved / Math.max(1, statsCounter.saved + statsCounter.failed)) * 100}%"></div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📅 Kalender Filter Media</div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <input type="date" id="calendarFilter" class="btn btn-ghost" style="width: 100%; text-align: center; color: var(--text-primary);" value="${targetDate || ''}" onchange="filterByDate(this.value)">
        ${targetDate ? `<button class="btn btn-danger btn-sm" onclick="filterByDate('')" style="justify-content: center;">❌ Reset Tanggal</button>` : ''}
      </div>
    </div>

    <div class="card">
      <div class="card-title">📅 Hari Ini</div>
      <div style="display:flex; justify-content:space-around; text-align:center;">
        <div><div style="font-size:1.5rem; font-weight:700; color:var(--accent-green)">${todayStats.images}</div><div style="font-size:0.75rem; color:var(--text-muted)">Gambar</div></div>
        <div><div style="font-size:1.5rem; font-weight:700; color:var(--accent-blue)">${todayStats.videos}</div><div style="font-size:0.75rem; color:var(--text-muted)">Vid/Aud</div></div>
        <div><div style="font-size:1.5rem; font-weight:700; color:var(--accent-orange)">${todayStats.documents}</div><div style="font-size:0.75rem; color:var(--text-muted)">Dokumen</div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">📈 Aktivitas 7 Hari</div>
      <div class="activity-chart">
        ${(() => {
          const maxCount = Math.max(...Object.values(activity7Days), 1);
          return Object.entries(activity7Days).map(([day, count]) => {
            const date = new Date(day); const label = date.toLocaleDateString('id-ID', { weekday: 'short' });
            return `<div class="activity-bar-wrapper" style="cursor:pointer;" onclick="filterByDate('${day}')"><div class="activity-count">${count}</div><div class="activity-bar" style="height:${Math.max((count / maxCount) * 100, 4)}%"></div><div class="activity-label">${label}</div></div>`;
          }).join('');
        })()}
      </div>
    </div>

    ${qrImage ? `<div class="card qr-section"><div class="card-title">🔗 Scan QR WhatsApp</div><img src="${qrImage}" alt="QR Code"><p>Scan untuk menghubungkan</p></div>` : ''}

    <div class="card">
      <div class="card-title">👥 Grup (${groups.length})</div>
      <div class="group-list">
        ${groups.map((g) => {
          const isPinned = pinnedList.includes(g);
          return `
          <div class="group-item ${g === selectedGroup ? 'active' : ''}">
            <a href="/?group=${encodeURIComponent(g)}&date=${targetDate || ''}" class="group-main-clickable">
              <div class="group-avatar">${isPinned ? '📌' : '👥'}</div>
              <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${g}</span>
            </a>
            <button class="btn-pin ${isPinned ? 'pinned' : ''}" data-group="${g.replace(/"/g, '&quot;')}" data-pin="${!isPinned}" title="${isPinned ? 'Unpin Grup' : 'Pin Grup'}">📌</button>
          </div>`;
        }).join('')}
      </div>
    </div>

    <!-- LIVE ACTIVITY FEED -->
    <div class="card">
      <div class="card-title">⚡ Aktivitas Terbaru</div>
      <div class="activity-feed" id="activityFeed" style="max-height:200px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; font-size:0.78rem;">
        <div style="color:var(--text-muted); text-align:center; padding:10px;">Menunggu aktivitas baru...</div>
      </div>
    </div>
  </aside>

  <main class="main-content">
    <div class="card" style="padding:16px;">
      <form method="GET" class="toolbar" id="filterForm">
        <input type="hidden" name="group" value="${selectedGroup || ''}">
        <input type="hidden" name="date" value="${targetDate || ''}">
        <div class="search-box"><span class="search-icon">🔍</span><input type="text" name="search" placeholder="Cari..." value="${req.query.search || ''}"></div>
        <div class="filter-tabs">
          <a href="/?group=${selectedGroup || ''}&date=${targetDate || ''}&type=all" class="filter-tab ${type === 'all' ? 'active' : ''}">Semua</a>
          <a href="/?group=${selectedGroup || ''}&date=${targetDate || ''}&type=images" class="filter-tab ${type === 'images' ? 'active' : ''}">Gambar</a>
          <a href="/?group=${selectedGroup || ''}&date=${targetDate || ''}&type=videos" class="filter-tab ${type === 'videos' ? 'active' : ''}">Video/Audio</a>
          <a href="/?group=${selectedGroup || ''}&date=${targetDate || ''}&type=documents" class="filter-tab ${type === 'documents' ? 'active' : ''}">Dokumen</a>
        </div>
        <select name="sort" class="btn btn-ghost btn-sm" style="padding:8px 12px;">
          <option value="newest" ${req.query.sort === 'newest' || !req.query.sort ? 'selected' : ''}>Terbaru</option>
          <option value="oldest" ${req.query.sort === 'oldest' ? 'selected' : ''}>Terlama</option>
          <option value="largest" ${req.query.sort === 'largest' ? 'selected' : ''}>Terbesar</option>
          <option value="smallest" ${req.query.sort === 'smallest' ? 'selected' : ''}>Terkecil</option>
          <option value="name" ${req.query.sort === 'name' ? 'selected' : ''}>Nama A-Z</option>
        </select>
        <button type="submit" class="btn btn-primary btn-sm">Filter</button>
      </form>
      
      ${selectedGroup ? `
      <div style="margin-top: 14px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 12px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary);">
          <span>Mulai:</span><input type="date" id="chatStart" class="btn btn-ghost btn-sm" style="padding:4px 8px;">
          <span>Selesai:</span><input type="date" id="chatEnd" class="btn btn-ghost btn-sm" style="padding:4px 8px;">
        </div>
        <button onclick="triggerChatExport()" class="btn btn-ghost btn-sm" style="border-color: var(--accent-orange); color: var(--accent-orange); font-size: 0.82rem;">
          📝 Ekspor Riwayat Chat (.txt)
        </button>
      </div>
      ` : ''}
    </div>

    ${selectedGroup ? `<div class="group-stats"><span>📷 <strong>${groupStats.images}</strong> Gambar</span><span>🎥 <strong>${groupStats.videos}</strong> Video/Audio</span><span>📄 <strong>${groupStats.documents}</strong> Dokumen</span> ${targetDate ? `<span style="color:var(--accent-blue);">📅 Filter Tanggal: <strong>${targetDate}</strong></span>` : ''}</div>` : ''}

    <div class="gallery">
      ${gallery.length === 0 ? `<div class="empty-state" style="grid-column: 1 / -1;"><div class="icon">📭</div><p>Tidak ada media</p></div>` : 
      gallery.map((f) => {
        const item = helperFormatCardData(f, selectedGroup, MEDIA_DIR);
        
        const hoverCardHTML = '<div class="hover-sender-container"><a class="chip-sender" href="/?group=' + encodeURIComponent(selectedGroup || '') + '&search=' + encodeURIComponent(item.number || '') + '">👤 ' + item.sender + '</a><div class="sender-hover-card"><div class="hover-card-avatar">👤</div><div class="hover-card-name">' + item.sender + '</div><div class="hover-card-num">@' + item.number + '</div><div class="hover-card-count">📦 Shared: ' + item.totalMediaContributed + ' File</div></div></div>';

        if (item.isPlayable) {
          return `<div class="gallery-item" data-src="${item.src}" data-type="${item.type}" data-name="${item.name.replace(/"/g, '&quot;')}" style="cursor:pointer;"><div class="media-preview">${item.type === 'image' ? '<img src="' + item.src + '" loading="lazy">' : '<span class="icon-placeholder">' + (item.type === 'video' ? '🎥' : '🎵') + '</span>'}</div><div class="card-info"><div class="card-filename" title="${item.name.replace(/"/g, '&quot;')}">${item.name}</div><div class="card-row-details"><span class="badge-type badge-${item.type}">${item.type}</span><span>${hoverCardHTML}</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ${item.size}</span><span>🕒 ${item.time}</span></div></div></div>`;
        } else {
          return `<div class="gallery-item" data-src="${item.src}" data-type="${item.type}" data-name="${item.name.replace(/"/g, '&quot;')}" style="cursor:pointer;"><div class="media-preview"><span class="icon-placeholder">📄</span></div><div class="card-info"><div class="card-filename" title="${item.name.replace(/"/g, '&quot;')}">${item.name}</div><div class="card-row-details"><span class="badge-type badge-doc">Dokumen</span><span>${hoverCardHTML}</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ${item.size}</span><span>🕒 ${item.time}</span></div></div></div>`;
        }
      }).join('')}
    </div>

    ${hasMore ? `
    <div style="text-align: center; margin-top: 24px;" id="loadMoreContainer">
      <button id="btnLoadMore" class="btn btn-ghost" onclick="loadMoreMedia()">🔽 <span id="btnText">Muat Lebih Banyak</span></button>
    </div>` : ''}

    <div class="failed-log-section">
      <div class="card-title" style="color:var(--accent-red)">⚠️ Log Media Gagal & Unduh Ulang Manual</div>
      ${failedList.length === 0 ? `<p style="font-size:0.85rem; color:var(--text-muted);">Keren! Tidak ada log media gagal tercatat saat ini.</p>` : `
      <div style="overflow-x:auto;">
        <table class="failed-log-table">
          <thead>
            <tr>
              <th>🕒 Waktu</th>
              <th>👥 Grup</th>
              <th>👤 Pengirim</th>
              <th>📂 Tipe</th>
              <th>❌ Keterangan Error</th>
              <th style="text-align:center;">🔄 Aksi</th>
            </tr>
          </thead>
          <tbody>
            ${failedList.map(f => {
              const resDownloadBtn = f.messageId ? `<button class="btn btn-ghost btn-sm btn-redownload" style="color:var(--accent-blue); border-color:var(--accent-blue); padding:4px 8px; font-size:0.75rem;" data-msgid="${f.messageId}">Unduh Ulang</button>` : '<span style="color:var(--text-muted); font-size:0.7rem;">No MsgID</span>';
              return `<tr><td>${f.time}</td><td><strong>${f.group}</strong></td><td>${f.sender}</td><td><span class="badge-type badge-doc" style="background:rgba(248,81,73,0.1); color:var(--accent-red); border:1px solid rgba(248,81,73,0.2)">${f.type}</span></td><td style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${(f.error || '').replace(/"/g, '&quot;')}"><code>${f.error || ''}</code></td><td style="text-align:center;">${resDownloadBtn}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      `}
    </div>
  </main>
</div>

<script>
let images = []; 
let currentIndex = 0; 
let currentPage = 2;

const eventSource = new EventSource("/api/events");
eventSource.onmessage = function(event) {
  const data = JSON.parse(event.data);
  showNotificationToast(data);
  updateActivityFeed(data);
};

function updateActivityFeed(media) {
  var feed = document.getElementById("activityFeed");
  if (!feed) return;

  // Remove "waiting" message
  var waiting = feed.querySelector("[style*='text-align:center']");
  if (waiting) waiting.remove();

  // Create feed item
  var item = document.createElement("div");
  item.className = "feed-item";
  var now = new Date();
  var timeStr = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0") + ":" + now.getSeconds().toString().padStart(2,"0");
  var typeIcon = {images:"📷", videos:"🎬", documents:"📎"};
  var icon = typeIcon[media.type] || "📁";
  item.innerHTML = '<div class="feed-dot"></div><div class="feed-content"><span class="feed-sender">' + (media.sender || "Unknown") + '</span> ' + icon + ' kirim ' + (media.type || "media") + '<br><span class="feed-time">' + timeStr + ' • ' + (media.group || "") + '</span></div>';

  // Tambah ke atas
  feed.insertBefore(item, feed.firstChild);

  // Max 15 items
  while (feed.children.length > 15) {
    feed.removeChild(feed.lastChild);
  }
}

function showNotificationToast(media) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  
  const toast = document.createElement("div");
  toast.className = "toast-item";
  toast.innerHTML = '<div class="toast-header"><span>📥 File Masuk Baru</span><span style="cursor:pointer; color:var(--text-muted);" onclick="this.parentElement.parentElement.remove()">✕</span></div><div class="toast-body"><strong>Grup:</strong> ' + (media.group || 'Unknown') + '<br><strong>Dari:</strong> ' + (media.sender || 'Unknown') + '<br>📁 ' + (media.file || 'Media File') + '</div>';
  container.appendChild(toast);
  setTimeout(function() { if(toast) toast.remove(); }, 6000);
}

async function togglePinGroup(groupName, pinStatus) {
  try {
    const response = await fetch("/api/pin-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: groupName, pin: pinStatus })
    });
    const res = await response.json();
    if(res.success) { window.location.reload(); }
  } catch(e) { console.error(e); }
}

async function requestReDownload(msgId, element) {
  const oldText = element.textContent;
  element.disabled = true;
  element.textContent = "Memproses...";
  
  try {
    const response = await fetch("/api/redownload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: msgId })
    });
    const res = await response.json();
    if(res.success) {
      alert("✅ " + res.message);
      element.textContent = "Sukses! 🔄";
    } else {
      alert("❌ Gagal: " + res.error);
      element.textContent = oldText;
      element.disabled = false;
    }
  } catch(err) {
    alert("❌ Error Server Dashboard.");
    element.textContent = oldText;
    element.disabled = false;
  }
}

function filterByDate(val) {
  const url = new URL(window.location.href);
  if(val) url.searchParams.set("date", val);
  else url.searchParams.delete("date");
  window.location.href = url.toString();
}

function triggerChatExport() {
  const start = document.getElementById("chatStart").value;
  const end = document.getElementById("chatEnd").value;
  const currentGroup = document.querySelector("input[name=group]").value;
  let targetUrl = "/api/export-chat?group=" + encodeURIComponent(currentGroup);
  if(start) targetUrl += "&start_date=" + start;
  if(end) targetUrl += "&end_date=" + end;
  window.location.href = targetUrl;
}

window.onscroll = function() {
  const btn = document.getElementById("btnTop");
  if (document.body.scrollTop > 400 || document.documentElement.scrollTop > 400) {
    btn.style.display = "flex";
  } else {
    btn.style.display = "none";
  }
};

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleTheme() {
  document.body.classList.toggle("light-theme");
  var isLight = document.body.classList.contains("light-theme");
  localStorage.setItem("theme", isLight ? "light" : "dark");
}
// Load saved theme
if (localStorage.getItem("theme") === "light") {
  document.body.classList.add("light-theme");
}

function refreshLightboxQueue() {
  images = [];
  document.querySelectorAll('.gallery-item[data-src]').forEach(item => { 
    images.push({ 
      src: item.getAttribute('data-src'), 
      type: item.getAttribute('data-type'), 
      name: item.getAttribute('data-name') 
    }); 
  });
}

refreshLightboxQueue();

function openLightbox(src, type, name) {
  refreshLightboxQueue();
  currentIndex = images.findIndex(function(img) { return img.src === src; }); 
  if (currentIndex === -1) { currentIndex = 0; images = [{src: src, type: type, name: name}]; }
  renderCurrentMedia();
  document.getElementById("lightbox").classList.add("active");
}

// EVENT DELEGATION - handles all clicks without inline onclick
document.addEventListener("click", function(e) {
  // Gallery item click -> open lightbox
  var galleryItem = e.target.closest(".gallery-item");
  if (galleryItem && !e.target.closest(".card-info")) {
    var src = galleryItem.getAttribute("data-src");
    var type = galleryItem.getAttribute("data-type");
    var name = galleryItem.getAttribute("data-name");
    if (src) {
      if (type === "image" || type === "video" || type === "audio") {
        openLightbox(src, type, name);
      } else {
        window.open(src, "_blank");
      }
    }
    return;
  }

  // Pin button click
  var pinBtn = e.target.closest(".btn-pin");
  if (pinBtn) {
    e.preventDefault();
    e.stopPropagation();
    var groupName = pinBtn.getAttribute("data-group");
    var pinStatus = pinBtn.getAttribute("data-pin") === "true";
    if (groupName) togglePinGroup(groupName, pinStatus);
    return;
  }

  // Redownload button click
  var redownloadBtn = e.target.closest(".btn-redownload");
  if (redownloadBtn) {
    e.preventDefault();
    e.stopPropagation();
    var msgId = redownloadBtn.getAttribute("data-msgid");
    if (msgId) requestReDownload(msgId, redownloadBtn);
    return;
  }
});

function renderCurrentMedia() {
  const item = images[currentIndex];
  if (!item) return;

  const imgEl = document.getElementById("lightboxImg");
  const videoEl = document.getElementById("lightboxVideo");
  const audioEl = document.getElementById("lightboxAudio");
  const infoEl = document.getElementById("lightboxInfo");

  imgEl.style.display = "none";
  videoEl.style.display = "none";
  audioEl.style.display = "none";
  videoEl.pause();
  audioEl.pause();

  infoEl.textContent = item.name || '';

  if (item.type === 'image') {
    imgEl.src = item.src;
    imgEl.style.display = "block";
  } else if (item.type === 'video') {
    videoEl.src = item.src;
    videoEl.style.display = "block";
    videoEl.load();
    videoEl.play().catch(function(){});
  } else if (item.type === 'audio') {
    audioEl.src = item.src;
    audioEl.style.display = "block";
    audioEl.load();
    audioEl.play().catch(function(){});
  }
}

function closeLightbox() { 
  document.getElementById("lightboxVideo").pause();
  document.getElementById("lightboxAudio").pause();
  document.getElementById("lightbox").classList.remove("active"); 
}

function nextImage() { 
  if(images.length === 0) return; 
  currentIndex = (currentIndex + 1) % images.length; 
  renderCurrentMedia();
}

function prevImage() { 
  if(images.length === 0) return; 
  currentIndex = (currentIndex - 1 + images.length) % images.length; 
  renderCurrentMedia();
}

document.addEventListener("keydown", function(e) {
  const lb = document.getElementById("lightbox");
  if (!lb || !lb.classList.contains("active")) return;
  if (e.key === "ArrowRight") nextImage();
  if (e.key === "ArrowLeft") prevImage();
  if (e.key === "Escape") closeLightbox();
});

async function loadMoreMedia() {
  const btn = document.getElementById("btnLoadMore"); if (!btn) return;
  const btnText = document.getElementById("btnText");
  const urlParams = new URLSearchParams(window.location.search);
  const group = urlParams.get("group") || ""; const type = urlParams.get("type") || "all";
  const date = urlParams.get("date") || "";
  
  btnText.textContent = "Memuat Data..."; 
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  btn.insertBefore(spinner, btnText);
  btn.disabled = true;

  try {
    const response = await fetch('/api/media?group=' + encodeURIComponent(group) + '&page=' + currentPage + '&type=' + type + '&date=' + date);
    const result = await response.json();
    if (result.data && result.data.length > 0) {
      const galleryDiv = document.querySelector(".gallery");
      result.data.forEach(item => {
        let html = '';
        const hoverCardHTML = '<div class="hover-sender-container"><a class="chip-sender" href="/?group=' + encodeURIComponent(selectedGroup || '') + '&search=' + encodeURIComponent(item.number || '') + '">👤 ' + item.sender + '</a><div class="sender-hover-card"><div class="hover-card-avatar">👤</div><div class="hover-card-name">' + item.sender + '</div><div class="hover-card-num">@' + item.number + '</div><div class="hover-card-count">📦 Shared: ' + item.totalMediaContributed + ' File</div></div></div>';

        if (item.isPlayable) {
          html = '<div class="gallery-item" data-src="' + item.src + '" data-type="' + item.type + '" data-name="' + item.name + '" style="cursor:pointer;"><div class="media-preview">' + (item.type === 'image' ? '<img src="' + item.src + '" loading="lazy">' : '<span class="icon-placeholder">' + (item.type === 'video' ? '🎥' : '🎵') + '</span>') + '</div><div class="card-info"><div class="card-filename" title="' + item.name + '">' + item.name + '</div><div class="card-row-details"><span class="badge-type badge-' + item.type + '">' + item.type + '</span><span>' + hoverCardHTML + '</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ' + item.size + '</span><span>🕒 ' + item.time + '</span></div></div></div>';
        } else {
          html = '<div class="gallery-item" data-src="' + item.src + '" data-type="' + item.type + '" data-name="' + item.name + '" style="cursor:pointer;"><div class="media-preview"><span class="icon-placeholder">📄</span></div><div class="card-info"><div class="card-filename" title="' + item.name + '">' + item.name + '</div><div class="card-row-details"><span class="badge-type badge-doc">Dokumen</span><span>' + hoverCardHTML + '</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ' + item.size + '</span><span>🕒 ' + item.time + '</span></div></div></div>';
        }
        galleryDiv.insertAdjacentHTML('beforeend', html);
      });
      
      refreshLightboxQueue();

      if (result.hasMore) { 
        currentPage++; 
        btnText.textContent = "Muat Lebih Banyak"; 
        if (btn.querySelector(".spinner")) btn.querySelector(".spinner").remove();
        btn.disabled = false; 
      } else { 
        document.getElementById("loadMoreContainer").remove(); 
      }
    } else { 
      document.getElementById("loadMoreContainer").remove(); 
    }
  } catch (err) { 
    console.error(err); 
    btnText.textContent = "Gagal memuat"; 
    if (btn.querySelector(".spinner")) btn.querySelector(".spinner").remove();
    btn.disabled = false; 
  }
}
</script>
</body>
</html>
  `);
});

// ==========================================
// HALAMAN BLACKLIST/WHITELIST GRUP
// ==========================================
app.get("/blacklist", async (req, res) => {
  const IGNORED_FILE = path.join(__dirname, "ignored-groups.json");
  let ignoredGroups = [];
  try { if (fs.existsSync(IGNORED_FILE)) ignoredGroups = JSON.parse(fs.readFileSync(IGNORED_FILE, "utf8")); } catch {}

  const allGroups = await getGroups();

  let waStatus = "OFFLINE";
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    waStatus = status.connected ? "ONLINE" : "OFFLINE";
  } catch {}

  // Build group cards HTML
  let activeGroupsHtml = "";
  let ignoredGroupsHtml = "";

  allGroups.forEach(function(g) {
    const isIgnored = ignoredGroups.includes(g);
    const card = `<div class="bl-group-card ${isIgnored ? 'ignored' : 'active'}" data-group="${g.replace(/"/g, '&quot;')}">
      <div class="bl-group-icon">${isIgnored ? '🚫' : '✅'}</div>
      <div class="bl-group-name">${g}</div>
      <button class="bl-toggle-btn ${isIgnored ? 'btn-unignore' : 'btn-ignore'}" data-group="${g.replace(/"/g, '&quot;')}" data-action="${isIgnored ? 'unignore' : 'ignore'}">
        ${isIgnored ? '↩️ Aktifkan' : '🚫 Nonaktifkan'}
      </button>
    </div>`;

    if (isIgnored) ignoredGroupsHtml += card;
    else activeGroupsHtml += card;
  });

  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blacklist Grup - WA Media Dashboard</title>
<style>
:root {
  --bg-primary: #0d1117; --bg-secondary: #161b22; --bg-tertiary: #21262d; --bg-hover: #30363d; --border: #30363d;
  --text-primary: #e6edf3; --text-secondary: #8b949e; --text-muted: #6e7681; --accent-green: #25D366; --accent-blue: #58a6ff;
  --accent-red: #f85149; --accent-orange: #d29922; --radius-sm: 6px; --radius-md: 10px; --radius-lg: 16px; --shadow: 0 8px 24px rgba(0,0,0,0.4);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg-primary); color: var(--text-primary); min-height: 100vh; }
.header { background: var(--bg-secondary); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
.header h1 { font-size: 1.3rem; font-weight: 700; display: flex; align-items: center; gap: 10px; }
.header-actions { display: flex; gap: 10px; }
.btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: var(--radius-sm); font-size: 0.85rem; font-weight: 600; text-decoration: none; border: none; cursor: pointer; transition: all 0.2s; }
.btn-back { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border); }
.btn-back:hover { background: var(--bg-hover); border-color: var(--accent-blue); }
.container { max-width: 1200px; margin: 0 auto; padding: 24px; }
.page-title { font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 24px; }
.section-box { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 24px; overflow: hidden; }
.section-header { padding: 16px 20px; background: var(--bg-tertiary); border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
.section-header:hover { background: var(--bg-hover); }
.section-header h2 { font-size: 0.95rem; font-weight: 600; display: flex; align-items: center; gap: 10px; }
.section-header .count { background: var(--bg-primary); padding: 2px 10px; border-radius: 12px; font-size: 0.75rem; color: var(--text-muted); }
.section-header .arrow { font-size: 1.2rem; color: var(--text-muted); transition: transform 0.3s; }
.section-header.open .arrow { transform: rotate(180deg); }
.section-content { display: none; padding: 16px 20px; }
.section-content.open { display: block; }
.bl-group-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.bl-group-card { background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 14px 16px; display: flex; align-items: center; gap: 12px; transition: all 0.2s; }
.bl-group-card:hover { border-color: var(--accent-blue); transform: translateY(-1px); }
.bl-group-card.ignored { border-color: rgba(248, 81, 73, 0.3); background: rgba(248, 81, 73, 0.05); }
.bl-group-card.active { border-color: rgba(37, 211, 102, 0.3); background: rgba(37, 211, 102, 0.05); }
.bl-group-icon { font-size: 1.5rem; flex-shrink: 0; }
.bl-group-name { flex: 1; font-size: 0.88rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bl-toggle-btn { padding: 6px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.2s; white-space: nowrap; }
.btn-ignore { background: transparent; color: var(--accent-red); border-color: var(--accent-red); }
.btn-ignore:hover { background: var(--accent-red); color: #fff; }
.btn-unignore { background: transparent; color: var(--accent-green); border-color: var(--accent-green); }
.btn-unignore:hover { background: var(--accent-green); color: #fff; }
.empty-msg { color: var(--text-muted); font-size: 0.85rem; padding: 20px; text-align: center; }
.toast-msg { position: fixed; bottom: 24px; right: 24px; background: var(--bg-secondary); border: 1px solid var(--accent-green); border-radius: var(--radius-md); padding: 12px 20px; color: var(--accent-green); font-size: 0.85rem; box-shadow: var(--shadow); z-index: 9999; display: none; animation: fadeIn 0.3s; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 768px) { .bl-group-grid { grid-template-columns: 1fr; } .container { padding: 12px; } }
</style>
</head>
<body>

<header class="header">
  <h1>🚫 Kelola Blacklist Grup</h1>
  <div class="header-actions">
    <span style="padding:6px 14px; border-radius:20px; font-size:0.8rem; font-weight:600; ${waStatus === 'ONLINE' ? 'background:rgba(37,211,102,0.15);color:#25D366;border:1px solid rgba(37,211,102,0.3);' : 'background:rgba(248,81,73,0.15);color:#f85149;border:1px solid rgba(248,81,73,0.3);'}">${waStatus}</span>
    <a href="/" class="btn btn-back">⬅️ Kembali Dashboard</a>
  </div>
</header>

<div class="container">
  <p class="page-title">Kelola grup mana yang medianya <strong>disimpan</strong> atau <strong>diabaikan</strong> oleh bot. Grup yang di-blacklist tidak akan diunduh medianya.</p>

  <!-- SECTION: BLACKLISTED GROUPS -->
  <div class="section-box">
    <div class="section-header open" onclick="toggleSection(this)">
      <h2>🚫 Grup Dinonaktifkan (Blacklist) <span class="count">${ignoredGroups.length}</span></h2>
      <span class="arrow">▼</span>
    </div>
    <div class="section-content open">
      ${ignoredGroupsHtml ? '<div class="bl-group-grid">' + ignoredGroupsHtml + '</div>' : '<p class="empty-msg">Belum ada grup yang di-blacklist. Semua grup aktif menyimpan media.</p>'}
    </div>
  </div>

  <!-- SECTION: ACTIVE GROUPS -->
  <div class="section-box">
    <div class="section-header open" onclick="toggleSection(this)">
      <h2>✅ Grup Aktif (Menyimpan Media) <span class="count">${allGroups.length - ignoredGroups.length}</span></h2>
      <span class="arrow">▼</span>
    </div>
    <div class="section-content open">
      ${activeGroupsHtml ? '<div class="bl-group-grid">' + activeGroupsHtml + '</div>' : '<p class="empty-msg">Tidak ada grup aktif.</p>'}
    </div>
  </div>
</div>

<div class="toast-msg" id="toastMsg"></div>

<script>
function toggleSection(el) {
  el.classList.toggle("open");
  var content = el.nextElementSibling;
  content.classList.toggle("open");
}

function showToast(msg) {
  var toast = document.getElementById("toastMsg");
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(function() { toast.style.display = "none"; }, 3000);
}

document.addEventListener("click", function(e) {
  var btn = e.target.closest(".bl-toggle-btn");
  if (!btn) return;

  var groupName = btn.getAttribute("data-group");
  var action = btn.getAttribute("data-action");
  var shouldIgnore = (action === "ignore");

  btn.disabled = true;
  btn.textContent = "Memproses...";

  fetch("/api/ignore-group", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: groupName, ignore: shouldIgnore })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.success) {
      showToast(shouldIgnore ? "🚫 " + groupName + " di-blacklist" : "✅ " + groupName + " diaktifkan kembali");
      setTimeout(function() { location.reload(); }, 800);
    } else {
      btn.disabled = false;
      btn.textContent = action === "ignore" ? "🚫 Nonaktifkan" : "↩️ Aktifkan";
      alert("Gagal: " + (d.error || "Unknown"));
    }
  })
  .catch(function() {
    btn.disabled = false;
    btn.textContent = action === "ignore" ? "🚫 Nonaktifkan" : "↩️ Aktifkan";
    alert("Error koneksi server");
  });
});
</script>
</body>
</html>`);
});

// ==========================================
// HALAMAN ANTI-DELETE VIEWER
// ==========================================
app.get("/antidelete", (req, res) => {
  const ANTIDELETE_FILE = path.join(__dirname, "antidelete-log.json");
  let logs = [];
  try { if (fs.existsSync(ANTIDELETE_FILE)) logs = JSON.parse(fs.readFileSync(ANTIDELETE_FILE, "utf8")); } catch {}

  let waStatus = "OFFLINE";
  try { const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); waStatus = status.connected ? "ONLINE" : "OFFLINE"; } catch {}

  const logsHtml = logs.length === 0 ? '<p style="text-align:center;color:var(--text-muted);padding:40px;">Belum ada pesan yang ditarik/dihapus tercatat.</p>' :
    logs.slice(0, 50).map(function(item) {
      return '<div style="background:var(--bg-tertiary);border:1px solid var(--border);border-radius:10px;padding:14px 18px;display:flex;gap:14px;align-items:flex-start;"><div style="font-size:1.8rem;">🗑</div><div style="flex:1;"><div style="font-weight:600;font-size:0.9rem;margin-bottom:4px;">' + (item.group || 'Unknown') + '</div><div style="font-size:0.8rem;color:var(--text-secondary);">👤 ' + (item.sender || 'Unknown') + ' &bull; 📱 ' + (item.number || '-') + '</div><div style="font-size:0.8rem;color:var(--text-muted);margin-top:4px;">💬 ' + (item.content || '-') + '</div><div style="font-size:0.72rem;color:var(--text-muted);margin-top:6px;">🕒 ' + (item.time || '-') + ' &bull; ID: <code>' + (item.messageId || '-') + '</code></div></div></div>';
    }).join('');

  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anti-Delete Viewer - WA Media Dashboard</title>
<style>
:root { --bg-primary:#0d1117;--bg-secondary:#161b22;--bg-tertiary:#21262d;--bg-hover:#30363d;--border:#30363d;--text-primary:#e6edf3;--text-secondary:#8b949e;--text-muted:#6e7681;--accent-green:#25D366;--accent-blue:#58a6ff;--accent-red:#f85149;--accent-orange:#d29922;--radius-sm:6px;--radius-md:10px;--radius-lg:16px;--shadow:0 8px 24px rgba(0,0,0,0.4); }
* { margin:0;padding:0;box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh; }
.header { background:var(--bg-secondary);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100; }
.header h1 { font-size:1.3rem;font-weight:700;display:flex;align-items:center;gap:10px; }
.btn { display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:600;text-decoration:none;border:none;cursor:pointer;transition:all 0.2s;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border); }
.btn:hover { background:var(--bg-hover);border-color:var(--accent-blue); }
.container { max-width:900px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:12px; }
.stats-bar { display:flex;gap:16px;padding:12px 16px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-md);font-size:0.85rem;color:var(--text-secondary); }
</style>
</head>
<body>
<header class="header">
  <h1>🗑 Anti-Delete Viewer</h1>
  <div style="display:flex;gap:10px;align-items:center;">
    <span style="padding:6px 14px;border-radius:20px;font-size:0.8rem;font-weight:600;${waStatus === 'ONLINE' ? 'background:rgba(37,211,102,0.15);color:#25D366;border:1px solid rgba(37,211,102,0.3);' : 'background:rgba(248,81,73,0.15);color:#f85149;border:1px solid rgba(248,81,73,0.3);'}">${waStatus}</span>
    <a href="/" class="btn">⬅️ Dashboard</a>
  </div>
</header>
<div class="container">
  <div class="stats-bar">
    <span>📊 Total pesan ditarik tercatat: <strong>${logs.length}</strong></span>
    <span>📅 Menampilkan 50 terbaru</span>
  </div>
  ${logsHtml}
</div>
</body>
</html>`);
});

// ==========================================
// REPORT GENERATOR API
// ==========================================
app.post("/api/generate-report", async (req, res) => {
  const { group, startDate, endDate } = req.body;
  if (!group || !startDate) return res.status(400).json({ error: "Grup dan tanggal wajib diisi" });

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY belum diset di .env" });

  try {
    var NL = String.fromCharCode(10);
    var endDt = endDate || startDate;

    // 1. Ambil chat history
    var logFile = path.join(MEDIA_DIR, group, "chat_history.jsonl");
    var chats = [];
    if (fs.existsSync(logFile)) {
      var content = fs.readFileSync(logFile, "utf8");
      var lines = content.trim().split(String.fromCharCode(10)).filter(Boolean);
      lines.forEach(function(line) {
        try {
          var chat = JSON.parse(line);
          var chatDate = (chat.time || "").slice(0, 10);
          if (chatDate >= startDate && chatDate <= endDt) {
            chats.push(chat);
          }
        } catch (e) {}
      });
    }

    // 2. Ambil media files dalam rentang tanggal
    var mediaResult = await getGroupMedia(group, 1, 99999, null);
    var allMedia = mediaResult.data;
    var mediaInRange = allMedia.filter(function(f) {
      try {
        var stat = fs.statSync(f.path);
        var fileDate = new Date(stat.mtime).toISOString().slice(0, 10);
        return fileDate >= startDate && fileDate <= endDt;
      } catch (e) { return false; }
    });

    // 3. Hitung statistik
    var photoCount = 0, videoCount = 0, docCount = 0;
    var photos = [];
    mediaInRange.forEach(function(f) {
      var ext = path.extname(f.name).toLowerCase();
      if ([".jpg", ".jpeg", ".png", ".webp"].indexOf(ext) !== -1) {
        photoCount++;
        photos.push(f);
      } else if ([".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].indexOf(ext) !== -1) {
        videoCount++;
      } else {
        docCount++;
      }
    });

    // 4. Siapkan chat text untuk AI (max 12000 chars)
    var chatText = chats.map(function(c) {
      return "[" + c.time + "] " + c.sender + ": " + c.message;
    }).join(NL);
    if (chatText.length > 12000) chatText = chatText.substring(chatText.length - 12000);

    // 5. Prompt Gemini - bahasa manusia natural
    var prompt = "Kamu adalah asisten yang membuat laporan progres proyek dari chat WhatsApp grup." + NL;
    prompt += "Tulis laporan dengan bahasa Indonesia yang NATURAL dan MANUSIAWI - seperti orang sungguhan menulis laporan, bukan seperti robot." + NL;
    prompt += "Jangan pakai format bullet point kaku. Tulis dalam paragraf yang mengalir, seperti email profesional ke klien." + NL + NL;
    prompt += "Grup: " + group + NL;
    prompt += "Periode: " + startDate + " s/d " + endDt + NL;
    prompt += "Total foto: " + photoCount + ", Video: " + videoCount + ", Dokumen: " + docCount + NL;
    prompt += "Total chat: " + chats.length + " pesan" + NL + NL;
    prompt += "Buatkan:" + NL;
    prompt += "1. Paragraf rangkuman aktivitas per hari (tulis natural)" + NL;
    prompt += "2. Poin-poin keputusan/target jika ada" + NL;
    prompt += "3. Masalah/kendala yang muncul jika ada" + NL;
    prompt += "4. Kesimpulan singkat 1-2 kalimat" + NL + NL;
    prompt += "--- LOG CHAT ---" + NL + chatText;

    // 6. Panggil Gemini (with retry + fallback)
    var axios = require("axios");
    var models = ["gemini-2.0-flash-lite", "gemini-2.5-flash"];
    var aiText = "";
    var lastErr = null;

    for (var mi = 0; mi < models.length; mi++) {
      var geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" + models[mi] + ":generateContent?key=" + GEMINI_KEY;
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var aiResponse = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
          }, { headers: { "Content-Type": "application/json" }, timeout: 60000 });

          if (aiResponse.data.candidates && aiResponse.data.candidates[0] && aiResponse.data.candidates[0].content) {
            aiText = aiResponse.data.candidates[0].content.parts[0].text || "";
          }
          if (aiText) break;
        } catch (gemErr) {
          lastErr = gemErr;
          var sc = gemErr.response ? gemErr.response.status : 0;
          if ((sc === 429 || sc === 503) && attempt === 0) {
            await new Promise(function(r) { setTimeout(r, 5000); });
          } else if (sc === 429 || sc === 503 || sc === 404) {
            break; // try next model
          } else {
            break;
          }
        }
      }
      if (aiText) break;
    }

    if (!aiText) {
      return res.status(500).json({ error: "Gemini API gagal: " + (lastErr ? (lastErr.response ? "status " + lastErr.response.status : lastErr.message) : "no response") });
    }

    // 7. Pilih highlight photos (max 12, spread across days)
    var highlightPhotos = [];
    var daysMap = {};
    photos.forEach(function(f) {
      try {
        var stat = fs.statSync(f.path);
        var day = new Date(stat.mtime).toISOString().slice(0, 10);
        if (!daysMap[day]) daysMap[day] = [];
        daysMap[day].push(f);
      } catch (e) {}
    });
    // Ambil max 2 foto per hari, total max 12
    Object.keys(daysMap).sort().forEach(function(day) {
      var dayPhotos = daysMap[day];
      var pick = dayPhotos.slice(0, 2);
      pick.forEach(function(p) {
        if (highlightPhotos.length < 12) {
          var relPath = path.relative(MEDIA_DIR, p.path).split("\\").join("/");
          highlightPhotos.push({ name: p.name, src: "/media/" + relPath, date: day });
        }
      });
    });

    // 8. Return result
    res.json({
      success: true,
      report: aiText,
      stats: { photos: photoCount, videos: videoCount, documents: docCount, chats: chats.length, participants: getUniqueParticipants(chats) },
      highlights: highlightPhotos,
      allPhotos: photos.slice(0, 50).map(function(p) {
        var relPath = path.relative(MEDIA_DIR, p.path).split("\\").join("/");
        return { name: p.name, src: "/media/" + relPath };
      })
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getUniqueParticipants(chats) {
  var s = {};
  chats.forEach(function(c) { s[c.sender] = true; });
  return Object.keys(s).length;
}

// ==========================================
// HALAMAN REPORT GENERATOR
// ==========================================
app.get("/report", async (req, res) => {
  const groups = await getGroups();
  let waStatus = "OFFLINE";
  try { const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); waStatus = status.connected ? "ONLINE" : "OFFLINE"; } catch {}

  const groupOptions = groups.map(function(g) {
    return '<option value="' + g.replace(/"/g, '&quot;') + '">' + g + '</option>';
  }).join("");

  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report Generator - WA Media Dashboard</title>
<style>
:root { --bg-primary:#0d1117;--bg-secondary:#161b22;--bg-tertiary:#21262d;--bg-hover:#30363d;--border:#30363d;--text-primary:#e6edf3;--text-secondary:#8b949e;--text-muted:#6e7681;--accent-green:#25D366;--accent-blue:#58a6ff;--accent-red:#f85149;--accent-orange:#d29922;--radius-sm:6px;--radius-md:10px;--radius-lg:16px;--shadow:0 8px 24px rgba(0,0,0,0.4); }
* { margin:0;padding:0;box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh; }
.header { background:var(--bg-secondary);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100; }
.header h1 { font-size:1.3rem;font-weight:700;display:flex;align-items:center;gap:10px; }
.btn { display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:600;text-decoration:none;border:none;cursor:pointer;transition:all 0.2s; }
.btn-back { background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border); }
.btn-back:hover { background:var(--bg-hover);border-color:var(--accent-blue); }
.btn-primary { background:var(--accent-blue);color:#fff;border:1px solid var(--accent-blue); }
.btn-primary:hover { opacity:0.9; }
.btn-primary:disabled { opacity:0.5;cursor:not-allowed; }
.container { max-width:1100px;margin:0 auto;padding:24px; }
.form-row { display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:24px;background:var(--bg-secondary);padding:16px 20px;border-radius:var(--radius-lg);border:1px solid var(--border); }
.form-group { display:flex;flex-direction:column;gap:4px; }
.form-group label { font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px; }
.form-group select, .form-group input { background:var(--bg-tertiary);border:1px solid var(--border);color:var(--text-primary);padding:8px 12px;border-radius:var(--radius-sm);font-size:0.85rem; }
.loading { text-align:center;padding:40px;color:var(--text-muted);display:none; }
.loading.active { display:block; }
.spinner-lg { display:inline-block;width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--accent-blue);border-radius:50%;animation:spin 0.8s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.report-container { display:none; }
.report-container.active { display:block; }
.report-stats { display:flex;gap:16px;flex-wrap:wrap;margin-bottom:20px; }
.stat-badge { background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);padding:12px 18px;text-align:center; }
.stat-badge .num { font-size:1.4rem;font-weight:700;color:var(--accent-green); }
.stat-badge .lbl { font-size:0.7rem;color:var(--text-muted);margin-top:2px; }
.report-text { background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;margin-bottom:20px; }
.report-text h3 { font-size:0.85rem;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px; }
.report-editor { width:100%;min-height:300px;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;color:var(--text-primary);font-size:0.9rem;line-height:1.7;resize:vertical;font-family:inherit; }
.report-editor:focus { outline:none;border-color:var(--accent-blue); }
.photos-section { background:var(--bg-secondary);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px;margin-bottom:20px; }
.photos-section h3 { font-size:0.85rem;color:var(--text-muted);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px; }
.photos-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px; }
.photo-card { position:relative;border-radius:var(--radius-md);overflow:hidden;cursor:pointer;border:2px solid transparent;transition:all 0.2s; }
.photo-card.selected { border-color:var(--accent-green);box-shadow:0 0 8px rgba(37,211,102,0.3); }
.photo-card img { width:100%;height:120px;object-fit:cover;display:block; }
.photo-card .check { position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:50%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-size:0.8rem; }
.photo-card.selected .check { background:var(--accent-green); }
.photo-card .photo-date { position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#fff;font-size:0.65rem;padding:3px 6px;text-align:center; }
.actions-bar { display:flex;gap:10px;flex-wrap:wrap;margin-top:20px;padding-top:16px;border-top:1px solid var(--border); }
.btn-copy { background:var(--accent-green);color:#fff;border:none; }
.btn-copy:hover { opacity:0.9; }
@media(max-width:768px) { .form-row { flex-direction:column; } .photos-grid { grid-template-columns:repeat(auto-fill,minmax(100px,1fr)); } }
</style>
</head>
<body>
<header class="header">
  <h1>📋 Report Generator</h1>
  <div style="display:flex;gap:10px;align-items:center;">
    <span style="padding:6px 14px;border-radius:20px;font-size:0.8rem;font-weight:600;${waStatus === 'ONLINE' ? 'background:rgba(37,211,102,0.15);color:#25D366;border:1px solid rgba(37,211,102,0.3);' : 'background:rgba(248,81,73,0.15);color:#f85149;border:1px solid rgba(248,81,73,0.3);'}">${waStatus}</span>
    <a href="/" class="btn btn-back">⬅️ Dashboard</a>
  </div>
</header>

<div class="container">
  <div class="form-row">
    <div class="form-group">
      <label>Pilih Grup</label>
      <select id="reportGroup">${groupOptions}</select>
    </div>
    <div class="form-group">
      <label>Dari Tanggal</label>
      <input type="date" id="reportStart">
    </div>
    <div class="form-group">
      <label>Sampai Tanggal</label>
      <input type="date" id="reportEnd">
    </div>
    <button class="btn btn-primary" id="btnGenerate" onclick="generateReport()">🤖 Generate Report</button>
  </div>

  <div class="loading" id="loadingState">
    <div class="spinner-lg"></div>
    <p style="margin-top:12px;">Sedang menganalisis chat dan media...</p>
    <p style="font-size:0.8rem;color:var(--text-muted);">Biasanya 5-15 detik</p>
  </div>

  <div class="report-container" id="reportResult">
    <div class="report-stats" id="reportStats"></div>

    <div class="report-text">
      <h3>📝 Rangkuman (bisa diedit)</h3>
      <textarea class="report-editor" id="reportEditor" placeholder="Rangkuman akan muncul di sini..."></textarea>
    </div>

    <div class="photos-section">
      <h3>📸 Highlight Foto (klik untuk pilih/batal)</h3>
      <div class="photos-grid" id="photosGrid"></div>
    </div>

    <div class="actions-bar">
      <button class="btn btn-copy" onclick="copyReport()">📋 Copy Rangkuman</button>
      <button class="btn btn-back" onclick="copyWithPhotos()">📸 Copy + Daftar Foto</button>
      <button class="btn btn-back" onclick="downloadReport()">💾 Download .txt</button>
      <button class="btn btn-back" onclick="printReport()">🖨 Print</button>
    </div>
  </div>
</div>

<script>
var selectedPhotos = [];

async function generateReport() {
  var group = document.getElementById("reportGroup").value;
  var startDate = document.getElementById("reportStart").value;
  var endDate = document.getElementById("reportEnd").value;

  if (!group || !startDate) { alert("Pilih grup dan tanggal mulai!"); return; }
  if (!endDate) endDate = startDate;

  var btn = document.getElementById("btnGenerate");
  btn.disabled = true;
  btn.textContent = "Generating...";
  document.getElementById("loadingState").classList.add("active");
  document.getElementById("reportResult").classList.remove("active");

  try {
    var response = await fetch("/api/generate-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: group, startDate: startDate, endDate: endDate })
    });
    var data = await response.json();

    if (!data.success) { alert("Gagal: " + (data.error || "Unknown")); return; }

    // Stats
    var statsHtml = "";
    statsHtml += '<div class="stat-badge"><div class="num">' + data.stats.photos + '</div><div class="lbl">Foto</div></div>';
    statsHtml += '<div class="stat-badge"><div class="num">' + data.stats.videos + '</div><div class="lbl">Video</div></div>';
    statsHtml += '<div class="stat-badge"><div class="num">' + data.stats.documents + '</div><div class="lbl">Dokumen</div></div>';
    statsHtml += '<div class="stat-badge"><div class="num">' + data.stats.chats + '</div><div class="lbl">Pesan</div></div>';
    statsHtml += '<div class="stat-badge"><div class="num">' + data.stats.participants + '</div><div class="lbl">Partisipan</div></div>';
    document.getElementById("reportStats").innerHTML = statsHtml;

    // Report text
    document.getElementById("reportEditor").value = data.report;

    // Photos
    selectedPhotos = data.highlights.map(function(p) { return p.src; });
    var allPhotos = data.allPhotos || [];
    var photosHtml = "";

    data.highlights.forEach(function(p) {
      var isSelected = selectedPhotos.indexOf(p.src) !== -1;
      photosHtml += '<div class="photo-card selected" data-src="' + p.src + '" onclick="togglePhoto(this)"><img src="' + p.src + '" loading="lazy"><div class="check">✓</div><div class="photo-date">' + (p.date || "") + '</div></div>';
    });

    // Show remaining photos (not highlighted)
    allPhotos.forEach(function(p) {
      if (selectedPhotos.indexOf(p.src) === -1) {
        photosHtml += '<div class="photo-card" data-src="' + p.src + '" onclick="togglePhoto(this)"><img src="' + p.src + '" loading="lazy"><div class="check">○</div><div class="photo-date">' + (p.name.substring(0, 8) || "") + '</div></div>';
      }
    });

    document.getElementById("photosGrid").innerHTML = photosHtml;
    document.getElementById("reportResult").classList.add("active");

  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🤖 Generate Report";
    document.getElementById("loadingState").classList.remove("active");
  }
}

function togglePhoto(el) {
  var src = el.getAttribute("data-src");
  el.classList.toggle("selected");
  var check = el.querySelector(".check");
  if (el.classList.contains("selected")) {
    selectedPhotos.push(src);
    check.textContent = "✓";
  } else {
    selectedPhotos = selectedPhotos.filter(function(s) { return s !== src; });
    check.textContent = "○";
  }
}

function copyReport() {
  var text = document.getElementById("reportEditor").value;
  navigator.clipboard.writeText(text).then(function() { alert("Rangkuman berhasil di-copy!"); });
}

function copyWithPhotos() {
  var text = document.getElementById("reportEditor").value;
  text += String.fromCharCode(10) + String.fromCharCode(10) + "--- FOTO TERPILIH ---" + String.fromCharCode(10);
  selectedPhotos.forEach(function(src, idx) {
    text += (idx + 1) + ". " + window.location.origin + src + String.fromCharCode(10);
  });
  navigator.clipboard.writeText(text).then(function() { alert("Rangkuman + daftar foto berhasil di-copy!"); });
}

function downloadReport() {
  var text = document.getElementById("reportEditor").value;
  var group = document.getElementById("reportGroup").value;
  var date = document.getElementById("reportStart").value;
  var blob = new Blob([text], { type: "text/plain" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Report_" + group.replace(/[^a-zA-Z0-9]/g, "_") + "_" + date + ".txt";
  a.click();
}

function printReport() {
  var group = document.getElementById("reportGroup").value;
  var startDate = document.getElementById("reportStart").value;
  var endDate = document.getElementById("reportEnd").value;
  var reportText = document.getElementById("reportEditor").value;
  var statsEl = document.getElementById("reportStats").innerHTML;

  // Ambil foto yang selected
  var photosHtml = "";
  var selectedCards = document.querySelectorAll(".photo-card.selected img");
  for (var i = 0; i < selectedCards.length; i++) {
    photosHtml += '<img src="' + selectedCards[i].src + '" style="width:180px;height:130px;object-fit:cover;border-radius:6px;margin:4px;">';
  }

  var printWindow = window.open("", "_blank");
  printWindow.document.write('<html><head><title>Report - ' + group + '</title>');
  printWindow.document.write('<style>');
  printWindow.document.write('body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:40px;color:#1a1a1a;line-height:1.7;max-width:800px;margin:0 auto;}');
  printWindow.document.write('h1{font-size:20px;border-bottom:2px solid #333;padding-bottom:8px;margin-bottom:16px;}');
  printWindow.document.write('.meta{font-size:13px;color:#555;margin-bottom:20px;}');
  printWindow.document.write('.stats{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap;}');
  printWindow.document.write('.stat-box{background:#f5f5f5;padding:10px 16px;border-radius:6px;text-align:center;border:1px solid #ddd;}');
  printWindow.document.write('.stat-box .num{font-size:18px;font-weight:700;}');
  printWindow.document.write('.stat-box .lbl{font-size:11px;color:#777;}');
  printWindow.document.write('.report-body{white-space:pre-wrap;font-size:14px;background:#fafafa;padding:20px;border-radius:8px;border:1px solid #eee;margin-bottom:20px;}');
  printWindow.document.write('.photos{margin-top:16px;}');
  printWindow.document.write('.photos img{border:1px solid #ddd;}');
  printWindow.document.write('.footer{margin-top:30px;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:10px;}');
  printWindow.document.write('@media print{body{padding:20px;}}');
  printWindow.document.write('</style></head><body>');
  printWindow.document.write('<h1>📋 Laporan: ' + group + '</h1>');
  printWindow.document.write('<div class="meta">📅 Periode: ' + startDate + (endDate && endDate !== startDate ? ' s/d ' + endDate : '') + '<br>🖨 Dicetak: ' + new Date().toLocaleString("id-ID") + '</div>');
  printWindow.document.write('<div class="report-body">' + reportText + '</div>');

  if (photosHtml) {
    printWindow.document.write('<div class="photos"><strong>📸 Foto Terpilih:</strong><br><br>' + photosHtml + '</div>');
  }

  printWindow.document.write('<div class="footer">Generated by WA Media Dashboard</div>');
  printWindow.document.write('</body></html>');
  printWindow.document.close();
  setTimeout(function() { printWindow.print(); }, 500);
}

// Set default date to today
var today = new Date().toISOString().split("T")[0];
document.getElementById("reportStart").value = today;
document.getElementById("reportEnd").value = today;
</script>
</body>
</html>`);
});

app.get("/restart-bot", (req, res) => { exec("pm2 restart wa-media", err => { if (err) return res.send("Restart gagal"); res.redirect("/"); }); });
app.get("/logout-wa", (req, res) => {
  const authPath = path.join(__dirname, "auth");
  try { if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true }); exec("pm2 restart wa-media"); res.send(`<h2>✅ Logout berhasil</h2><p>Bot sedang restart...</p><a href="/">Kembali Dashboard</a>`); } 
  catch (err) { res.send("Logout gagal"); }
});

app.listen(PORT, () => { console.log(`Dashboard running on http://localhost:${PORT}`); });