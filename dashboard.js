const QRCode = require("qrcode");
const express = require("express");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");

const app = express();
app.use(express.json());
app.use("/media", express.static(path.join(__dirname, "WA-MEDIA")));
const PORT = 3002;

const MEDIA_DIR = path.join(__dirname, "WA-MEDIA");
const STATUS_FILE = path.join(__dirname, "status.json");
const FAILED_FILE = path.join(__dirname, "failed-media.json");
const PINNED_FILE = path.join(__dirname, "pinned-groups.json");

let sseClients = [];

function sendLiveToastToBrowsers(data) {
  var newline = String.fromCharCode(10);
  var payload = "data: " + JSON.stringify(data) + newline + newline;
  sseClients.forEach(function(client) { client.res.write(payload); });
}

let lastSentMessageId = null;

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

// ==========================================
// DEKLARASI SEMUA FUNGSI PEMBANTU
// ==========================================

function loadPinnedGroups() {
  try { if (fs.existsSync(PINNED_FILE)) return JSON.parse(fs.readFileSync(PINNED_FILE, "utf8")); } catch {}
  return [];
}

function savePinnedGroups(pinned){
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned,null,2), "utf8");
}

function getSenderMediaCount(number) {
  if(!number || number === 'unknown') return 0;
  let db = [];
  try { db = JSON.parse(fs.readFileSync(path.join(__dirname, "media-db.json"), "utf8")); } catch { return 0; }
  return db.filter(x => x.number === number).length;
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
    src: "/media/" + relPath,
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

async function getFolderSize(dir) {
  let size = 0;
  async function walk(folder) {
    try { await fsPromises.access(folder); } catch { return; }
    const items = await fsPromises.readdir(folder, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(folder, item.name);
      if (item.isDirectory()) { await walk(fullPath); }
      else {
        if (item.name !== "chat_history.jsonl") {
          const stat = await fsPromises.stat(fullPath);
          size += stat.size;
        }
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

// ==========================================
// ROUTER ENDPOINTS MANAGEMENT
// ==========================================

// FIX #1: SSE endpoint for live toast notifications (was missing)
app.get("/api/events", function(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.write(String.fromCharCode(10));
  var client = { id: Date.now(), res: res };
  sseClients.push(client);
  req.on("close", function() {
    sseClients = sseClients.filter(function(c) { return c.id !== client.id; });
  });
});


// FIX #2: Redownload endpoint (was completely missing - button had no backend)
app.post("/api/redownload", (req, res) => {
  const { messageId } = req.body;
  if (!messageId) {
    return res.json({ success: false, error: "messageId tidak ditemukan" });
  }

  // Attempt to signal the WA bot to re-download via a redownload-queue file
  const queueFile = path.join(__dirname, "redownload-queue.json");
  let queue = [];
  try {
    if (fs.existsSync(queueFile)) {
      queue = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    }
  } catch { queue = []; }

  queue.push({ messageId: messageId, requestedAt: new Date().toISOString() });
  fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2), "utf8");

  // Also remove from failed-media.json after queuing
  try {
    if (fs.existsSync(FAILED_FILE)) {
      let failedList = JSON.parse(fs.readFileSync(FAILED_FILE, "utf8"));
      failedList = failedList.filter(f => f.messageId !== messageId);
      fs.writeFileSync(FAILED_FILE, JSON.stringify(failedList, null, 2), "utf8");
    }
  } catch {}

  res.json({ success: true, message: "Media telah ditambahkan ke antrian unduh ulang." });
});

app.get("/api/pinned", (req, res) => {
  res.json({ pinned: loadPinnedGroups() });
});

// FIX #3: Pin group endpoint - moved BEFORE the catch-all route and added error handling
app.post("/api/pin-group", (req, res) => {
  try {
    const { group, pin } = req.body;
    if (!group) {
      return res.json({ success: false, error: "Group kosong" });
    }

    let pinned = [];
    try {
      if (fs.existsSync(PINNED_FILE)) {
        pinned = JSON.parse(fs.readFileSync(PINNED_FILE, "utf8"));
      }
    } catch { pinned = []; }

    if (pin) {
      if (!pinned.includes(group)) pinned.push(group);
    } else {
      pinned = pinned.filter(g => g !== group);
    }

    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

// API endpoint for lazy-loading more media (pagination)
app.get("/api/media", async (req, res) => {
  const group = req.query.group || "";
  const page = parseInt(req.query.page) || 1;
  const type = req.query.type || "all";
  const targetDate = req.query.date || null;

  if (!group) return res.json({ data: [], hasMore: false });

  let result = await getGroupMedia(group, page, 40, targetDate);
  let files = result.data;

  if (type !== "all") {
    files = files.filter((f) => {
      const ext = path.extname(f.name).toLowerCase();
      if (type === "images") return [".jpg", ".jpeg", ".png", ".webp"].includes(ext);
      if (type === "videos") return [".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
      return ![".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".mkv", ".mp3", ".opus", ".wav"].includes(ext);
    });
  }

  const cards = files.map(f => helperFormatCardData(f, group, MEDIA_DIR));
  res.json({ data: cards, hasMore: result.hasMore });
});

// Chat export endpoint
app.get("/api/export-chat", async (req, res) => {
  const group = req.query.group || "";
  const startDate = req.query.start_date || null;
  const endDate = req.query.end_date || null;

  if (!group) return res.status(400).send("Group tidak ditemukan");

  const chatFile = path.join(MEDIA_DIR, group, "chat_history.jsonl");
  try {
    await fsPromises.access(chatFile);
    const content = await fsPromises.readFile(chatFile, "utf8");
    const lines = content.trim().split("
").filter(Boolean);
    let messages = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);

    if (startDate) messages = messages.filter(m => (m.timestamp || "").slice(0,10) >= startDate);
    if (endDate) messages = messages.filter(m => (m.timestamp || "").slice(0,10) <= endDate);

    const textContent = messages.map(m => `[${m.timestamp || ''}] ${m.sender || 'Unknown'}: ${m.message || ''}`).join("
");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="chat_${group}.txt"`);
    res.send(textContent || "Tidak ada riwayat chat.");
  } catch {
    res.status(404).send("File riwayat chat tidak ditemukan untuk grup ini.");
  }
});

app.get("/", async (req, res) => {
  const keyword = (req.query.search || "").toLowerCase().trim();
  const targetDate = req.query.date || null;
  const groups = await getGroups(); const selectedGroup = req.query.group || groups[0];
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
  const stats = await scanDir(MEDIA_DIR); const storage = await getFolderSize(MEDIA_DIR); const dbResults = searchMediaDB(keyword);
  let statsCounter = { saved: 0, failed: 0 }; try { statsCounter = JSON.parse(fs.readFileSync(path.join(__dirname, "stats.json"), "utf8")); } catch {}

  let failedList = []; try { if(fs.existsSync(FAILED_FILE)) failedList = JSON.parse(fs.readFileSync(FAILED_FILE, "utf8")).slice(0, 15); } catch(e){}

  const todayStats = await getTodayStats(); const activity7Days = await getActivity7Days();
  let waStatus = "OFFLINE"; let qrImage = "";
  try {
    const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    waStatus = status.connected ? "ONLINE" : "OFFLINE";
    if (status.qr) qrImage = await QRCode.toDataURL(status.qr);
  } catch {}

  let dateBtnHtml = "";
  if (targetDate) {
    dateBtnHtml = `<button class="btn btn-danger btn-sm" onclick="filterByDate('')" style="justify-content: center; width:100%; margin-top:8px;">✗ Reset Tanggal</button>`;
  }

  let chatOptionsHtml = "";
  if (selectedGroup) {
    chatOptionsHtml = `<div style="margin-top: 14px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 12px; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center; gap: 6px; font-size: 0.8rem; color: var(--text-secondary);">
          <span>Mulai:</span><input type="date" id="chatStart" class="btn btn-ghost btn-sm" style="padding:4px 8px;">
          <span>Selesai:</span><input type="date" id="chatEnd" class="btn btn-ghost btn-sm" style="padding:4px 8px;">
        </div>
        <button onclick="triggerChatExport()" class="btn btn-ghost btn-sm" style="border-color: var(--accent-orange); color: var(--accent-orange); font-size: 0.82rem;">
          📝 Ekspor Riwayat Chat (.txt)
        </button>
      </div>`;
  }

  // Render group list sidebar
  const groupListHtml = groups.map((g) => {
    const isPinned = pinnedList.includes(g);
    const safeGroupName = g.replace(/'/g, "\\'").replace(/"/g, "&quot;");
    return `<div class="group-item ${g === selectedGroup ? 'active' : ''}">
      <a href="/?group=${encodeURIComponent(g)}&date=${targetDate || ''}" class="group-main-clickable">
        <div class="group-avatar">${isPinned ? '📌' : '👥'}</div>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${g}</span>
      </a>
      <button class="btn-pin ${isPinned ? 'pinned' : ''}" onclick="event.preventDefault(); event.stopPropagation(); togglePinGroup('${safeGroupName}', ${!isPinned})" title="Pin/Unpin">📌</button>
    </div>`;
  }).join('');

  // FIX: Added data-src, data-type, data-name attributes so lightbox navigation works
  const galleryHtml = gallery.length === 0 ? `<div class="empty-state" style="grid-column: 1 / -1;"><div class="icon">📭</div><p>Tidak ada media</p></div>` :
  gallery.map((f) => {
    const item = helperFormatCardData(f, selectedGroup, MEDIA_DIR);
    const safeSrc = item.src.replace(/'/g, "\\'");
    const safeType = item.type.replace(/'/g, "\\'");
    const safeName = item.name.replace(/'/g, "\\'");
    const hoverCardHTML = '<div class="hover-sender-container"><span>👤 <u>' + item.sender + '</u></span><div class="sender-hover-card"><div class="hover-card-avatar">👤</div><div class="hover-card-name">' + item.sender + '</div><div class="hover-card-num">@' + item.number + '</div><div class="hover-card-count">📦 Shared: ' + item.totalMediaContributed + ' File</div></div></div>';

    if (item.isPlayable) {
      return '<div class="gallery-item" data-src="' + item.src + '" data-type="' + item.type + '" data-name="' + item.name.replace(/"/g, '"') + '" onclick="openLightbox(\'' + safeSrc + '\', \'' + safeType + '\', \'' + safeName + '\')"><div class="media-preview">' + (item.type === 'image' ? '<img src="' + item.src + '" loading="lazy">' : '<span class="icon-placeholder">' + (item.type === 'video' ? '🎥' : '🎵') + '</span>') + '</div><div class="card-info" onclick="event.stopPropagation()"><div class="card-filename" title="' + item.name + '">' + item.name + '</div><div class="card-row-details"><span class="badge-type badge-' + item.type + '">' + item.type + '</span><span>' + hoverCardHTML + '</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ' + item.size + '</span><span>🕒 ' + item.time + '</span></div></div></div>';
    } else {
      return '<div class="gallery-item" data-src="' + item.src + '" data-type="' + item.type + '" data-name="' + item.name.replace(/"/g, '"') + '" onclick="window.open(\'' + safeSrc + '\', \'_blank\')"><div class="media-preview"><span class="icon-placeholder">📄</span></div><div class="card-info" onclick="event.stopPropagation()"><div class="card-filename" title="' + item.name + '">' + item.name + '</div><div class="card-row-details"><span class="badge-type badge-doc">Dokumen</span><span>' + hoverCardHTML + '</span></div><div class="card-row-details" style="margin-top:2px; color:var(--text-muted);"><span>💾 ' + item.size + '</span><span>🕒 ' + item.time + '</span></div></div></div>';
    }
  }).join('');

  // Render failed log table rows
  const failedTableRowsHtml = failedList.length === 0 ? "<tr><td colspan='6' style='text-align:center; color:var(--text-muted); padding:20px;'>Keren! Tidak ada log media gagal tercatat saat ini.</td></tr>" : failedList.map(f => {
    const safeMsgId = (f.messageId || "").replace(/'/g, "\\'");
    const resDownloadBtn = f.messageId ? '<button class="btn btn-ghost btn-sm" style="color:var(--accent-blue); border-color:var(--accent-blue); padding:4px 8px; font-size:0.75rem;" onclick="event.preventDefault(); event.stopPropagation(); requestReDownload(\'' + safeMsgId + '\', this)">Unduh Ulang</button>' : '<span style="color:var(--text-muted); font-size:0.7rem;">No MsgID</span>';
    return '<tr><td>' + f.time + '</td><td><strong>' + f.group + '</strong></td><td>' + f.sender + '</td><td><span class="badge-type badge-doc" style="background:rgba(248,81,73,0.1); color:var(--accent-red); border:1px solid rgba(248,81,73,0.2)">' + f.type + '</span></td><td style="max-width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + (f.error || '') + '"><code>' + (f.error || '') + '</code></td><td style="text-align:center;">' + resDownloadBtn + '</td></tr>';
  }).join('');

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
.header-left { display: flex; align-items: center; gap
