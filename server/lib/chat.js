// chat.js - 账号间私聊消息 + 文件传输（JSON 存储，原子写）
// 结构：data/chat/state.json { messages: [...] }，附件放 data/chat/files/
// 消息：{ id, from, to, text, file:{id,name,size,mime}|null, at, readAt }
const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const config = require('../config');

const DIR = config.DIRS.chat;
const FILE_DIR = config.DIRS.chatFiles;
const STATE_FILE = path.join(DIR, 'state.json');
const MAX_MESSAGES = 20000; // 超出后丢弃最旧的消息（附件文件保留）
const MAX_TEXT = 2000;

let db = null;              // { messages: [] }
let loading = null;
let lockChain = Promise.resolve();   // 业务写锁（串行化消息变更）
let saveChain = Promise.resolve();   // 磁盘写队列（避免与业务锁互相等待）

function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

async function init() {
  if (db) return db;
  if (loading) return loading;
  loading = (async () => {
    await fs.mkdir(DIR, { recursive: true });
    await fs.mkdir(FILE_DIR, { recursive: true });
    if (fsSync.existsSync(STATE_FILE)) {
      try {
        const raw = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
        db = { messages: Array.isArray(raw.messages) ? raw.messages : [] };
      } catch (_) {
        db = { messages: [] };
      }
    } else {
      db = { messages: [] };
    }
    return db;
  })();
  return loading;
}

async function save() {
  const snapshot = JSON.stringify(db);
  const task = async () => {
    await fs.mkdir(DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    await fs.writeFile(tmp, snapshot, 'utf8');
    await fs.rename(tmp, STATE_FILE);
  };
  const p = saveChain.then(task, task);
  saveChain = p.catch(() => {});
  return p;
}

function withLock(fn) {
  const p = lockChain.then(fn, fn);
  lockChain = p.catch(() => {});
  return p;
}

function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
}

// 发送消息；file 为可选附件元信息
async function send({ from, to, text, file }) {
  await init();
  const body = normalizeText(text).slice(0, MAX_TEXT);
  if (!from || !to) throw new Error('缺少收件人');
  if (from === to) throw new Error('不能给自己发消息');
  if (!body && !file) throw new Error('消息不能为空');
  return withLock(async () => {
    const msg = {
      id: newId('msg'),
      from, to,
      text: body,
      file: file || null,
      at: nowIso(),
      readAt: null,
    };
    db.messages.push(msg);
    if (db.messages.length > MAX_MESSAGES) db.messages.splice(0, db.messages.length - MAX_MESSAGES);
    await save();
    return msg;
  });
}

// 保存附件到磁盘（调用方先决定文件名）
async function saveFile(buffer, originalName) {
  await init();
  const safeOriginal = String(originalName || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  const ext = (path.extname(safeOriginal) || '').slice(0, 12).replace(/[^.\w]/g, '');
  const id = newId('file');
  const storedName = id + ext;
  await fs.mkdir(FILE_DIR, { recursive: true });
  await fs.writeFile(path.join(FILE_DIR, storedName), buffer);
  return { id, name: safeOriginal, size: buffer.length, storedName };
}

function filePathOf(storedName) {
  const safe = path.basename(String(storedName || ''));
  return path.join(FILE_DIR, safe);
}

// 中文文件名修复：multipart 的 filename 有时被按 latin1 解码，转回 UTF-8
function fixFileName(name) {
  const raw = String(name || 'file');
  try {
    const buf = Buffer.from(raw, 'latin1');
    const utf8 = buf.toString('utf8');
    return utf8.includes('\uFFFD') ? raw : utf8;
  } catch (_) { return raw; }
}

// 接管 multer 落盘的临时文件：改名成 file_xxx.ext 并返回元信息
async function adoptFile(tmpPath, originalName) {
  await init();
  const name = String(fixFileName(originalName) || 'file').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  const ext = (path.extname(name).match(/^\.[A-Za-z0-9]{1,8}$/) ? path.extname(name) : '');
  const id = newId('file');
  const storedName = id + ext.toLowerCase();
  const dest = path.join(FILE_DIR, storedName);
  await fs.rename(tmpPath, dest).catch(async () => {
    await fs.copyFile(tmpPath, dest);
    await fs.unlink(tmpPath).catch(() => {});
  });
  const stat = await fs.stat(dest);
  return { id, name, size: stat.size, storedName };
}

// 取某段会话（两人之间），返回按时间升序
async function messagesWith(a, b, opts = {}) {
  await init();
  const limit = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 100));
  let list = db.messages.filter(
    (m) => (m.from === a && m.to === b) || (m.from === b && m.to === a)
  );
  if (opts.before) {
    const idx = list.findIndex((m) => m.id === opts.before);
    if (idx > 0) list = list.slice(0, idx);
    else if (idx === 0) list = [];
  }
  const total = list.length;
  const slice = list.slice(Math.max(0, list.length - limit));
  return { messages: slice, total, hasMore: slice.length < total };
}

function lastOf(list) {
  return list.length ? list[list.length - 1] : null;
}

// 某人的会话列表：每个对话对象一条，带最后一条消息与未读数
async function inbox(uid) {
  await init();
  const map = new Map();
  for (const m of db.messages) {
    if (m.from !== uid && m.to !== uid) continue;
    const peer = m.from === uid ? m.to : m.from;
    let row = map.get(peer);
    if (!row) {
      row = { peerId: peer, last: null, unread: 0, total: 0 };
      map.set(peer, row);
    }
    row.last = m;
    row.total++;
    if (m.to === uid && !m.readAt) row.unread++;
  }
  return Array.from(map.values());
}

async function unreadTotal(uid) {
  await init();
  let n = 0;
  for (const m of db.messages) if (m.to === uid && !m.readAt) n++;
  return n;
}

async function unreadByPeer(uid) {
  await init();
  const out = {};
  for (const m of db.messages) {
    if (m.to === uid && !m.readAt) out[m.from] = (out[m.from] || 0) + 1;
  }
  return out;
}

// 把某人发来的消息标记为已读；返回受影响条数
async function markRead(uid, peerId) {
  await init();
  return withLock(async () => {
    let n = 0;
    const at = nowIso();
    for (const m of db.messages) {
      if (m.to === uid && m.from === peerId && !m.readAt) {
        m.readAt = at;
        n++;
      }
    }
    if (n) await save();
    return n;
  });
}

// 主账号审计：全部会话（按最后消息倒序）
async function allConversations() {
  await init();
  const map = new Map();
  for (const m of db.messages) {
    const key = [m.from, m.to].sort().join('|');
    let row = map.get(key);
    if (!row) {
      row = { key, a: m.from, b: m.to, last: null, count: 0, files: 0, firstAt: m.at, lastAt: m.at };
      map.set(key, row);
    }
    row.last = m;
    row.count++;
    if (m.file) row.files++;
    row.lastAt = m.at;
  }
  return Array.from(map.values()).sort((x, y) => String(y.lastAt).localeCompare(String(x.lastAt)));
}

async function stats() {
  await init();
  const users = new Set();
  let files = 0;
  for (const m of db.messages) {
    users.add(m.from); users.add(m.to);
    if (m.file) files++;
  }
  return {
    messages: db.messages.length,
    files,
    participants: users.size,
    firstAt: db.messages.length ? db.messages[0].at : null,
    lastAt: db.messages.length ? db.messages[db.messages.length - 1].at : null,
  };
}

function canSeeMessage(actor, msg) {
  if (!actor || !msg) return false;
  if (actor.role === 'owner') return true;      // 主账号可审计全部
  return msg.from === actor.id || msg.to === actor.id;
}

// 删除账号时清理其聊天记录与附件，避免审计页留下「已删除账号」的残影
async function purgeUser(uid) {
  await init();
  return withLock(async () => {
    const keep = [];
    const drop = [];
    for (const m of db.messages) {
      if (m.from === uid || m.to === uid) drop.push(m);
      else keep.push(m);
    }
    if (!drop.length) return 0;
    db.messages = keep;
    await save();
    for (const m of drop) {
      if (m.file && m.file.storedName) {
        await fs.unlink(path.join(FILE_DIR, path.basename(m.file.storedName))).catch(() => {});
      }
    }
    return drop.length;
  });
}

async function findMessage(id) {
  await init();
  return db.messages.find((m) => m.id === id) || null;
}

async function findFileMessage(fileId) {
  await init();
  return db.messages.find((m) => m.file && m.file.id === fileId) || null;
}

module.exports = {
  init, send, saveFile, adoptFile, filePathOf, fixFileName, messagesWith, inbox, unreadTotal, unreadByPeer,
  markRead, allConversations, stats, canSeeMessage, findMessage, findFileMessage, purgeUser,
  MAX_TEXT, MAX_MESSAGES,
};
