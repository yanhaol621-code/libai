// common.js - 前端通用工具与 API 封装
const API = {
  async get(url) { return handle(await fetch(url)); },
  async post(url, body) { return handle(await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) })); },
  async postForm(url, form) { return handle(await fetch(url, { method:'POST', body: form })); },
  async patch(url, body) { return handle(await fetch(url, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) })); },
  async del(url) { return handle(await fetch(url, { method:'DELETE' })); },
};

// 统一处理响应：401 跳登录，其余错误抛出后端文案
async function handle(r) {
  if (r.status === 401) { redirectToLogin(); throw new Error('请先登录'); }
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || r.statusText);
  return r.json();
}

// ===== 登录态 =====
let ME = null;
function redirectToLogin() {
  if (location.pathname.endsWith('/login.html')) return;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace('/login.html?next=' + next);
}

// 页面初始化前调用：校验登录态、渲染导航用户信息
async function bootAuth(opts) {
  opts = opts || {};
  let r;
  try { r = await fetch('/api/auth/me'); } catch (_) { return false; }
  if (r.status === 401) { redirectToLogin(); return false; }
  if (!r.ok) return false;
  const j = await r.json();
  ME = j.user;
  window.ME = ME;   // 便于各页面通过 window.ME 判断身份（classic script 的 let 不挂到 window）
  renderUserNav();
  if (opts.ownerOnly && (!ME || ME.role !== 'owner')) {
    location.replace('/index.html');
    return false;
  }
  return true;
}

function renderUserNav() {
  const header = document.querySelector('.header');
  const nav = header && header.querySelector('.nav');
  if (!nav || !ME) return;
  nav.querySelectorAll('.auth-nav, .nav-chat').forEach((n) => n.remove());
  header.querySelectorAll('.header-user').forEach((n) => n.remove());

  // 消息：所有账号可见（未读数由实时推送刷新）
  const chatEntry = `<a class="auth-nav nav-chat" href="/chat.html" id="nav-chat" title="站内消息">消息` +
    `<span class="nav-badge" id="nav-chat-badge" hidden>0</span></a>`;
  nav.insertAdjacentHTML('beforeend', chatEntry);

  // 团队管理：主账号 + 管理岗（M1-M4）可见；管理权限与聊天记录仅主账号可见
  const team = (ME.role === 'owner' || ME.canAssignLevel)
    ? '<a class="auth-nav" href="/team.html">团队管理</a>'
    : '';
  const perms = ME.role === 'owner'
    ? '<a class="auth-nav" href="/permissions.html">管理权限</a><a class="auth-nav" href="/chat-audit.html">聊天记录</a>'
    : '';
  nav.insertAdjacentHTML('beforeend', team + perms);

  const roleTag = ME.role === 'owner' ? '主账号' : (ME.canAssignLevel ? '管理岗' : '运营');
  const initial = esc((ME.displayName || ME.username || '?').slice(0, 1));
  const avatar = ME.avatarUrl
    ? `<img class="chip-avatar" src="${esc(ME.avatarUrl)}" alt="">`
    : `<span class="chip-avatar chip-initial">${initial}</span>`;
  const lvl = levelBadges(ME, { quiet: true });
  // 身份与退出单独成组：桌面端靠右，移动端和 logo 同一行
  header.insertAdjacentHTML('beforeend',
    `<div class="header-user">` +
      `<a class="user-chip" href="/profile.html" title="我的资料 · 登录账号 ${esc(ME.account)}">` +
        avatar + `<span class="chip-dot dot-online" id="me-dot" title="在线"></span>` +
        `<span class="chip-name">${esc(ME.displayName || ME.username)}</span>` + lvl +
        `<i>${roleTag}</i>` +
      `</a>` +
      `<a class="auth-nav" href="javascript:void(0)" onclick="doLogout()">退出</a>` +
    `</div>`);
  updateChatBadge();

  // 任何页面打开都维持在线（登录即在线）
  startRealtime();
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  location.replace('/login.html');
}

function fmtSize(b){ if(!b) return '-'; if(b<1024) return b+'B'; if(b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(1)+'MB'; }
function fmtDur(s){ if(!s) return '-'; s=Math.round(s); const m=Math.floor(s/60); const ss=s%60; return m+':'+String(ss).padStart(2,'0'); }
function fmtDate(d){ if(!d) return '-'; const dt=new Date(d); return dt.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}); }
function toast(msg){ let t=document.querySelector('.toast'); if(!t){ t=document.createElement('div'); t.className='toast'; document.body.appendChild(t);} t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2200); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// 头像：有自定义头像用图片，否则用昵称首字
function avatarHtml(u, extraClass) {
  const name = String((u && (u.displayName || u.username)) || '?');
  const cls = 'avatar' + (extraClass ? ' ' + extraClass : '');
  if (u && u.avatarUrl) return `<span class="${cls}"><img src="${esc(u.avatarUrl)}" alt=""></span>`;
  return `<span class="${cls}">${esc(name.slice(0, 1))}</span>`;
}

// 职级徽章：管理层（金色）在前，专业职级（蓝色）在后，可同时显示；
// 两条都没有时给一个灰色「未定级」占位。
function levelBadges(u, opts) {
  if (!u) return '';
  const out = [];
  if (u.manageLevel) {
    const tip = [u.manageLevel, u.manageName, u.manageDesc].filter(Boolean).join(' · ');
    out.push(`<span class="lvl lvl-m" title="${esc(tip)}">${esc(u.manageLevel)}</span>`);
  }
  if (u.level) {
    const tip = [u.level, u.levelName, u.levelDesc].filter(Boolean).join(' · ');
    out.push(`<span class="lvl lvl-p" title="${esc(tip)}">${esc(u.level)}</span>`);
  }
  if (!out.length) {
    return (opts && opts.quiet) ? '' : '<span class="lvl lvl-none" title="还没定职级">未定级</span>';
  }
  return out.join('');
}

// 「M2 · P7」这样的纯文本（导出、标题、日志用）
function levelText(u) {
  if (!u) return '未定级';
  const parts = [];
  if (u.manageLevel) parts.push(u.manageLevel);
  if (u.level) parts.push(u.level);
  return parts.join(' · ') || '未定级';
}

// 兼容旧调用：levelBadge(u) 出徽章，levelBadge(u,{full:true}) 出文字
function levelBadge(u, opts) {
  if (!u) return '';
  if (opts && opts.full) {
    const parts = [];
    if (u.manageLevel) parts.push(`${u.manageLevel} · ${u.manageName || ''}`.trim());
    if (u.level) parts.push(`${u.level} · ${u.levelName || ''}`.trim());
    return `<span class="lvl-full">${esc(parts.join(' / ') || '未定级')}</span>`;
  }
  return levelBadges(u, opts);
}

// ===== 素材上传 =====
// 默认走「整文件直传」：一个请求写完，服务端只落一次盘 + 同盘改名，
// 不做任何转码/压缩/抽帧，落盘字节与本地原文件完全一致（画质零损失）。
// 直传失败（被代理截断、超大文件等）自动回退到「并行分片」，两条路都不改像素。
const UPLOAD_DIRECT_MAX = 8 * 1024 * 1024 * 1024; // 与服务端 8GB 上限一致

function directUpload(projectId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('filename', file.name);   // 中文名单独传，避免 multipart 文件名乱码
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${projectId}/upload/direct`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total * 99.5);
    };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 401) { redirectToLogin(); reject(new Error('请先登录')); return; }
      if (xhr.status >= 200 && xhr.status < 300 && j && j.material) {
        if (onProgress) onProgress(100);
        resolve(j);
      } else {
        reject(new Error((j && j.error) || ('上传失败（' + xhr.status + '）')));
      }
    };
    xhr.onerror = () => reject(new Error('网络中断'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(form);
  });
}

// 并行分片（回退通道）：8MB/片，6 路并发，最后服务端边读边拼
async function chunkUpload(projectId, file, onProgress) {
  const CHUNK = 8 * 1024 * 1024;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));
  const { uploadId } = await API.post(`/api/projects/${projectId}/upload/init`, {
    filename: file.name, totalChunks, fileSize: file.size, mime: file.type,
  });
  let uploaded = 0;
  let cursor = 0;
  const workers = Math.min(6, totalChunks);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= totalChunks) return;
      const start = i * CHUNK;
      const blob = file.slice(start, Math.min(start + CHUNK, file.size));
      const form = new FormData();
      form.append('chunk', blob);
      form.append('uploadId', uploadId);
      form.append('index', i);
      await API.postForm(`/api/projects/${projectId}/upload/chunk`, form);
      uploaded += blob.size;
      if (onProgress) onProgress(uploaded / file.size * 100);
    }
  }));
  return API.post(`/api/projects/${projectId}/upload/finish`, { uploadId });
}

async function uploadFile(projectId, file, onProgress) {
  if (file.size <= UPLOAD_DIRECT_MAX) {
    try {
      return await directUpload(projectId, file, onProgress);
    } catch (e) {
      if (e && e.message === '请先登录') throw e;
      // 直传失败：静默回退并行分片（进度条从当前值继续爬）
    }
  }
  return chunkUpload(projectId, file, onProgress);
}

// 简易事件流订阅
function subscribeStream(url, onMessage) {
  const es = new EventSource(url);
  es.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch(_){} };
  es.onerror = () => { /* 自动重连 */ };
  return es;
}

// ===== 导航当前页高亮 =====
(function highlightNav() {
  const mark = () => {
    const cur = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('.header .nav a').forEach((a) => {
      const href = (a.getAttribute('href') || '').split('?')[0].split('/').pop().toLowerCase();
      if (href && href === cur) a.classList.add('active');
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark);
  else mark();
})();


// ============================================================
// 在线状态 + 站内消息实时通道（所有页面共用）
// ============================================================
const PRESENCE_TEXT = { online: '在线', busy: '忙碌', away: '离开', offline: '离线' };

// 相对时间：刚刚 / x 分钟前 / x 小时前 / x 天前
function fmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' 小时前';
  const day = Math.floor(hr / 24);
  if (day < 30) return day + ' 天前';
  return fmtDate(iso);
}

// 在线文案：在线 / 忙碌 / 离开 / x 小时前在线
function presenceText(p) {
  if (!p) return '离线';
  if (p.online) return PRESENCE_TEXT[p.status] || '在线';
  const last = p.lastSeenAt || p.lastLoginAt;
  if (!last) return '从未登录';
  return fmtAgo(last) + '在线';
}

// 状态点（带颜色）
function dotHtml(p, opts) {
  const st = p && p.online ? (p.status || 'online') : 'offline';
  const cls = 'dot dot-' + st + ((opts && opts.large) ? ' dot-lg' : '');
  return `<span class="${cls}" title="${esc(presenceText(p))}"></span>`;
}

// 供各页面拿到同事在线状态
const RT = {
  state: {},          // uid -> presence
  users: [],          // 同事列表（chat/users 拉取过才有）
  totalUnread: 0,
  started: false,
  es: null,
  viewingPeer: null,  // 聊天页当前正在看的会话对方 uid（用于避免自己看着的会话也闪）
};

function updateChatBadge() {
  syncUnreadFavicon();
  const badge = document.getElementById('nav-chat-badge');
  if (!badge) return;
  const n = RT.totalUnread || 0;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n <= 0;
  const link = document.getElementById('nav-chat');
  if (link) link.classList.toggle('has-unread', n > 0);
}

function applyPresence(users) {
  if (!users) return;
  Object.assign(RT.state, users);
  document.querySelectorAll('[data-presence-uid]').forEach((el) => {
    const p = RT.state[el.getAttribute('data-presence-uid')];
    if (!p) return;
    el.innerHTML = dotHtml(p);
    const txt = el.parentElement && el.parentElement.querySelector('[data-presence-text]');
    if (txt) txt.textContent = presenceText(p);
  });
  const meDot = document.getElementById('me-dot');
  if (meDot && ME) {
    const p = RT.state[ME.id] || { online: true, status: 'online' };
    meDot.className = 'chip-dot dot-' + (p.online ? (p.status || 'online') : 'online');
    meDot.title = presenceText(p);
  }
  const st = document.getElementById('my-status-text');
  if (st && ME && RT.state[ME.id]) st.textContent = presenceText(RT.state[ME.id]);
  document.dispatchEvent(new CustomEvent('rt:presence', { detail: RT.state }));
}

// ============================================================
// 新消息提醒：浏览器标签标题 + 小图标交替闪动（全站生效）
// 收到别人发给我的消息时开始闪；切回本标签 / 打开该会话 / 60 秒后自动停。
// ============================================================
const NOTIFY = {
  base: null,        // 原始标题
  timer: null,
  on: false,
  count: 0,          // 累计未看的条数
  stopAt: 0,
  link: undefined,   // <link rel="icon">
  normalHref: '',    // 原图标地址
  dotHref: null,     // 带红点图标（异步生成）
  ready: false,
};

function notifyInit() {
  if (NOTIFY.base == null) NOTIFY.base = document.title || '';
  if (NOTIFY.link === undefined) {
    NOTIFY.link = document.querySelector('link[rel~="icon"]') || null;
    if (NOTIFY.link) {
      NOTIFY.normalHref = NOTIFY.link.getAttribute('href') || '';
      if (NOTIFY.normalHref && !NOTIFY.ready) buildDotIcon(NOTIFY.normalHref);
    }
  }
}

// 把站点图标画到 canvas 上，右上角加个红点，得到「有新消息」版本的 dataURL
function buildDotIcon(href) {
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const S = 64;
        const c = document.createElement('canvas');
        c.width = c.height = S;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, S, S);
        g.beginPath();
        g.arc(S - 15, 15, 10.5, 0, Math.PI * 2);
        g.fillStyle = '#f5222d';
        g.fill();
        g.lineWidth = 3.5;
        g.strokeStyle = '#ffffff';
        g.stroke();
        NOTIFY.dotHref = c.toDataURL('image/png');
        NOTIFY.ready = true;
      } catch (_) {}
    };
    img.onerror = () => {};
    img.src = href;
  } catch (_) {}
}

function setFavicon(showDot) {
  const l = NOTIFY.link;
  if (!l) return;
  const href = showDot ? (NOTIFY.dotHref || NOTIFY.normalHref) : NOTIFY.normalHref;
  if (href) l.setAttribute('href', href);
}

// 有新消息 → 开始闪（已在闪时只累加条数）
function notifyNewMessage(msg) {
  if (!msg || !ME) return;
  if (msg.to !== ME.id) return;                       // 只提醒别人发给我的
  if (location.pathname.endsWith('/login.html')) return;
  // 页面就在眼前、而且正看着这个人的会话：消息已经显示出来了，不闪
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  if (focused && RT.viewingPeer === msg.from) return;

  notifyInit();
  NOTIFY.count++;
  NOTIFY.stopAt = Date.now() + 60000;                 // 最多闪 60 秒
  if (NOTIFY.on) return;

  NOTIFY.on = true;
  let flip = false;
  const tick = () => {
    if (Date.now() > NOTIFY.stopAt) { stopNotify(); return; }
    flip = !flip;
    const n = NOTIFY.count;
    document.title = flip ? `【${n > 1 ? n + ' 条' : ''}新消息】${NOTIFY.base || ''}` : (NOTIFY.base || document.title);
    setFavicon(flip);
  };
  tick();
  NOTIFY.timer = setInterval(tick, 900);
}

function stopNotify() {
  if (!NOTIFY.on) return;
  NOTIFY.on = false;
  NOTIFY.count = 0;
  if (NOTIFY.timer) { clearInterval(NOTIFY.timer); NOTIFY.timer = null; }
  if (NOTIFY.base != null) document.title = NOTIFY.base;
  setFavicon(false);
  syncUnreadFavicon();   // 闪动停了但还有未读 → 图标保留红点
}

// 有未读时图标常驻红点（不在闪动中才接管）；未读清零后自动恢复原图标
function syncUnreadFavicon() {
  if (NOTIFY.on) return;                                          // 正在闪，交给闪动逻辑
  if (NOTIFY.base === null && NOTIFY.link === undefined) return;  // 还没初始化
  setFavicon((RT.totalUnread || 0) > 0);
}

// 切回本标签 / 窗口重新获得焦点 → 视为已看到，停止闪动并还原标题
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') stopNotify();
});
window.addEventListener('focus', stopNotify);

// 断开实时连接：页面卸载时必须主动关闭，
// 否则旧文档的 EventSource 会一直占着浏览器对同一域名的连接（上限 6 条），
// 连开几层页面后新页面就抢不到连接、整站卡住。
function rtClose() {
  if (RT.timer) { clearInterval(RT.timer); RT.timer = null; }
  if (RT.es) {
    try { RT.es.onmessage = null; RT.es.onerror = null; RT.es.close(); } catch (_) {}
    RT.es = null;
  }
  RT.started = false;
}

// 启动心跳 + SSE（只启一次）
function startRealtime() {
  if (!ME) return;
  if (RT.es) return;             // 已经有连接就不重复建
  RT.started = true;
  notifyInit();                  // 记下原标题与图标，备用
  syncUnreadFavicon();           // 进页面时若已有未读，图标直接带红点
  const ping = () => fetch('/api/presence/ping', { method: 'POST' }).catch(() => {});
  ping();
  RT.timer = setInterval(ping, 25000);

  try {
    const es = new EventSource('/api/chat/stream');
    RT.es = es;
    es.onmessage = (e) => {
      let d;
      try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d.type === 'ready') {
        applyPresence(d.users);
        RT.totalUnread = d.totalUnread || 0;
        updateChatBadge();
      } else if (d.type === 'presence') {
        applyPresence(d.users);
      } else if (d.type === 'chat') {
        document.dispatchEvent(new CustomEvent('rt:chat', { detail: d.message }));
        if (d.message && d.message.to === ME.id) {
          RT.totalUnread = (RT.totalUnread || 0) + 1;
          updateChatBadge();
          notifyNewMessage(d.message);   // 浏览器标签闪动提醒
        }
      } else if (d.type === 'unread') {
        RT.totalUnread = d.total || 0;
        updateChatBadge();
      } else if (d.type === 'read') {
        document.dispatchEvent(new CustomEvent('rt:read', { detail: d }));
      }
    };
    es.onerror = () => { /* 浏览器会自动重连 */ };
  } catch (_) {}
}

// 卸载即断开（含 bfcache 场景：pagehide 关连接，返回时 pageshow 重连）
window.addEventListener('pagehide', rtClose);
window.addEventListener('beforeunload', rtClose);
window.addEventListener('pageshow', (e) => { if (e.persisted) startRealtime(); });

// 切换自己的在线模式
async function setMyStatus(status) {
  try {
    const r = await API.post('/api/presence/status', { status });
    applyPresence({ [ME.id]: r.me });
    toast('已切换为「' + presenceText(r.me) + '」');
    return r.me;
  } catch (e) { toast(e.message); }
}

/* ============================================================
   全站环境动效：登录页那套「漂浮气泡 + 金色小星」推广到所有页面，
   并延伸出大光斑、扩散光环、细光点（纯 CSS 动画，不跑 JS 循环）
   单页想关掉：<html data-no-ambient>；系统开了「减少动态效果」时自动不生成
   ============================================================ */
const AMBIENT = (() => {
  let built = false;
  // 固定种子的伪随机：各页面装饰位置一致，看起来才像同一套视觉
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function build() {
    if (built) return;
    built = true;
    const root = document.documentElement;
    if (root.hasAttribute('data-no-ambient')) return;
    if (!document.body) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (document.querySelector('.mx-bg')) return;

    const rnd = mulberry32(20261028);
    const pick = (a, b) => a + rnd() * (b - a);
    const round = (n) => Math.round(n * 10) / 10;
    const host = document.createElement('div');
    host.className = 'mx-bg';
    host.setAttribute('aria-hidden', 'true');
    const parts = [];

    // 1) 四团大光斑（蓝 / 金 / 青），负责整体氛围
    const orbs = [
      { w: 700, x: -8, y: -14, c: 'rgba(111,160,245,.40)' },
      { w: 540, x: 64, y: 66, c: 'rgba(246,196,69,.24)' },
      { w: 600, x: 70, y: -12, c: 'rgba(143,208,255,.30)' },
      { w: 460, x: -10, y: 58, c: 'rgba(150,196,252,.28)' },
    ];
    orbs.forEach((o, i) => {
      parts.push(`<span class="mx-orb" style="width:${o.w}px;height:${o.w}px;left:${o.x}%;top:${o.y}%;`
        + `background:radial-gradient(circle at 50% 50%, ${o.c}, transparent 68%);`
        + `animation-duration:${round(38 + i * 6)}s;animation-delay:${round(-i * 8)}s"></span>`);
    });

    // 装饰主要落在两侧留白（中间多半被卡片盖住），少量散在页面内当氛围
    const edgeX = () => {
      const r = rnd();
      if (r < 0.34) return round(pick(1.5, 11));
      if (r < 0.68) return round(pick(89, 98.5));
      return round(pick(8, 92));
    };

    // 2) 漂浮气泡：从底部升起（登录页同款，数量略增、大小错落）
    for (let i = 0; i < 9; i++) {
      const size = Math.round(pick(12, 36));
      const dur = Math.round(pick(16, 30));
      parts.push(`<span class="mx-bubble" style="width:${size}px;height:${size}px;left:${edgeX()}%;`
        + `animation-duration:${dur}s;animation-delay:${round(-pick(0, dur))}s;opacity:0"></span>`);
    }

    // 3) 金色小星：一闪一闪。位置按「左右留白优先」排好，保证两侧空白处一直有小星在闪
    const STAR_SLOTS = [
      [4, 11], [7, 33], [3, 57], [9, 79],           // 左侧留白
      [96, 9], [93, 29], [97, 54], [92, 75],        // 右侧留白
      [46, 5], [58, 91],                            // 页面中部（多在卡片后，只当氛围）
    ];
    STAR_SLOTS.forEach(([sx, sy]) => {
      const fs = Math.round(pick(12, 24));
      parts.push(`<span class="mx-star" style="left:${sx + round(pick(-1.5, 1.5))}%;top:${sy + round(pick(-2, 2))}%;`
        + `font-size:${fs}px;animation-delay:${round(-pick(0, 5.6))}s">✦</span>`);
    });

    // 4) 扩散光环（新延伸）：像水面涟漪，一圈圈散开，固定落在四角留白
    const PING_SLOTS = [[5, 24], [95, 16], [8, 72], [91, 62]];
    PING_SLOTS.forEach(([sx, sy], i) => {
      const size = Math.round(pick(90, 150));
      parts.push(`<span class="mx-ping" style="width:${size}px;height:${size}px;left:${sx}%;top:${sy}%;`
        + `animation-duration:${round(pick(9, 15))}s;animation-delay:${round(-pick(0, 9))}s"></span>`);
    });

    // 5) 细小光点（新延伸）：近处静止的浮尘，增加层次
    for (let i = 0; i < 12; i++) {
      const size = round(pick(2, 4.5));
      parts.push(`<span class="mx-dot" style="width:${size}px;height:${size}px;left:${edgeX()}%;`
        + `top:${round(pick(4, 95))}%;animation-duration:${round(pick(11, 20))}s;`
        + `animation-delay:${round(-pick(0, 14))}s;opacity:${round(pick(0.25, 0.55))}"></span>`);
    }

    host.innerHTML = parts.join('');
    document.body.appendChild(host);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, { once: true });
  else build();
  return { build };
})();
