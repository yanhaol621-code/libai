// presence.js - 在线状态（心跳 / 手动状态）与实时推送（SSE）
// 在线判定：有活跃的 SSE 连接，或最近 HEARTBEAT_WINDOW 毫秒内有过心跳。
// 状态取值：online 在线 / busy 忙绿 / away 离开 / offline 离线（离线不可手动设置）
const HEARTBEAT_WINDOW = 75 * 1000;   // 超过 75 秒没有心跳且没有连接 => 离线
const SWEEP_INTERVAL = 15 * 1000;     // 每 15 秒检查一次，发现掉线就广播
const PERSIST_THROTTLE = 60 * 1000;   // 最近在线时间写盘频率（每人最多 1 分钟一次）

const STATUSES = ['online', 'busy', 'away'];
const STATUS_TEXT = { online: '在线', busy: '忙碌', away: '离开', offline: '离线' };

// uid -> { status, manual, lastSeen, since, clients:Set, lastPersist }
const state = new Map();
const clients = new Map(); // uid -> Set<res>

function entry(uid) {
  let e = state.get(uid);
  if (!e) {
    e = { status: 'online', manual: false, lastSeen: 0, since: Date.now(), clients: new Set(), lastPersist: 0 };
    state.set(uid, e);
  }
  return e;
}

function isOnline(uid) {
  const e = state.get(uid);
  if (!e) return false;
  if (e.forcedOffline) return false;
  if (e.clients.size > 0) return true;
  return Date.now() - e.lastSeen < HEARTBEAT_WINDOW;
}

function stateOf(uid) {
  const e = state.get(uid);
  const online = isOnline(uid);
  return {
    online,
    status: online ? (e ? e.status : 'online') : 'offline',
    statusText: online ? (STATUS_TEXT[e ? e.status : 'online'] || '在线') : '离线',
    lastSeen: e ? (e.lastSeen || null) : null,
    since: online && e ? e.since : null,
  };
}

function snapshot() {
  const out = {};
  for (const uid of state.keys()) out[uid] = stateOf(uid);
  return out;
}

// ---------- 实时连接（SSE） ----------
function send(res, payload) {
  try { res.write(`data: ${JSON.stringify(payload)}\n\n`); return true; } catch (_) { return false; }
}

function attach(uid, res) {
  const e = entry(uid);
  e.clients.add(res);
  if (!e.lastSeen) e.since = Date.now();
  e.lastSeen = Date.now();
  if (!e.manual) e.status = 'online';
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
  res.on('close', () => detach(uid, res));
  return e;
}

function detach(uid, res) {
  const e = state.get(uid);
  if (e) {
    e.clients.delete(res);
    e.lastSeen = Date.now();
  }
  const set = clients.get(uid);
  if (set) {
    set.delete(res);
    if (!set.size) clients.delete(uid);
  }
}

function push(uid, payload) {
  const set = clients.get(uid);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const res of set) if (send(res, payload)) n++;
  return n;
}

function pushAll(payload) {
  for (const uid of clients.keys()) push(uid, payload);
}

// ---------- 心跳 ----------
let persistTimer = null;
function schedulePersist(uid) {
  const e = entry(uid);
  const now = Date.now();
  if (now - (e.lastPersist || 0) < PERSIST_THROTTLE) return;
  e.lastPersist = now;
  // 延迟合并写盘，避免高频请求打满磁盘
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const auth = require('./auth');
      const snap = snapshot();
      for (const [id, s] of Object.entries(snap)) {
        if (s.lastSeen) await auth.touchSeen(id, new Date(s.lastSeen).toISOString());
      }
    } catch (_) { /* 在线状态写盘失败不影响使用 */ }
  }, 2000);
}

function touch(uid) {
  if (!uid) return stateOf(uid);
  const e = entry(uid);
  const wasOffline = !isOnline(uid);
  e.forcedOffline = false;
  e.lastSeen = Date.now();
  if (!e.manual) e.status = 'online';
  if (wasOffline) e.since = Date.now();
  schedulePersist(uid);
  return stateOf(uid);
}

// 登录成功：强制置为在线（清掉上次的忙碌/离开）
function markLogin(uid) {
  const e = entry(uid);
  e.lastSeen = Date.now();
  e.since = Date.now();
  e.manual = false;
  e.forcedOffline = false;
  e.status = 'online';
  const s = stateOf(uid);
  pushAll({ type: 'presence', users: { [uid]: s }, at: new Date().toISOString() });
  return s;
}

// 手动切换状态：online / busy / away
function setStatus(uid, status) {
  const s = String(status || '').toLowerCase();
  if (STATUSES.indexOf(s) < 0) throw new Error('未知的在线状态');
  const e = entry(uid);
  e.forcedOffline = false;
  e.status = s;
  e.manual = s !== 'online';
  e.lastSeen = Date.now();
  const out = stateOf(uid);
  pushAll({ type: 'presence', users: { [uid]: out }, at: new Date().toISOString() });
  return out;
}

// 主动退出登录：立刻置离线（下次心跳/登录自动恢复）
function markOffline(uid) {
  const e = state.get(uid);
  if (!e) return stateOf(uid);
  e.status = 'offline';
  e.manual = false;
  e.forcedOffline = true;
  e.lastSeen = Date.now();
  const out = stateOf(uid);
  pushAll({ type: 'presence', users: { [uid]: out }, at: new Date().toISOString() });
  return out;
}

// ---------- 掉线检测 ----------
let sweepStarted = false;
function startSweeper() {
  if (sweepStarted) return;
  sweepStarted = true;
  setInterval(() => {
    let changed = false;
    const now = Date.now();
    for (const [uid, e] of state.entries()) {
      const online = !e.forcedOffline && (e.clients.size > 0 || now - e.lastSeen < HEARTBEAT_WINDOW);
      if (!online && e.status !== 'offline') {
        e.status = 'offline';
        e.manual = false;
        changed = true;
      }
    }
    if (changed) pushAll({ type: 'presence', users: snapshot(), at: new Date().toISOString() });
  }, SWEEP_INTERVAL).unref?.();
}

// 成员列表里展示用：在线状态 + 最近在线/登录
function viewOf(user, lastSeenAt) {
  const s = stateOf(user.id);
  return {
    id: user.id,
    online: s.online,
    status: s.status,
    statusText: s.statusText,
    onlineSince: s.since,
    lastSeenAt: s.lastSeen ? new Date(s.lastSeen).toISOString() : (lastSeenAt || null),
    lastLoginAt: user.lastLoginAt || null,
  };
}

module.exports = {
  STATUSES, STATUS_TEXT, HEARTBEAT_WINDOW,
  attach, detach, push, pushAll, send, touch, markLogin, markOffline, setStatus,
  isOnline, stateOf, snapshot, startSweeper, viewOf,
};
