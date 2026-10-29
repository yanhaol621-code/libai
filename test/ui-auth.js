// test/ui-auth.js - 账号体系界面端到端测试（CDP 真实浏览器）
const http = require('http');
const fs = require('fs');
const path = require('path');
const CDP_PORT = process.env.CDP_PORT || 9333;
const BASE = 'http://localhost:3000';
const SHOT_DIR = path.join(__dirname, '..', 'data', 'temp', 'shot');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); } });
    return c;
  }
  send(method, params = {}) { return new Promise((resolve) => { const i = ++this.id; this.pending.set(i, resolve); this.ws.send(JSON.stringify({ id: i, method, params })); }); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  }
  async goto(url) { await this.send('Page.navigate', { url }); await sleep(600); }
  async waitFor(expr, label, tries = 50) {
    for (let i = 0; i < tries; i++) { await sleep(300); if (await this.eval(expr)) return true; }
    throw new Error('等待超时：' + label);
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    if (!r.result?.data) return;
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'));
    console.log('  截图 →', name);
  }
}

(async () => {
  let target = null;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (_) {}
    await sleep(500);
  }
  if (!target) throw new Error('未找到浏览器页面');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCookies');   // 每次测试从「未登录」开始
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // ---------- 1. 未登录访问首页应跳登录 ----------
  await cdp.goto(BASE + '/index.html');
  await cdp.waitFor(`location.pathname === '/login.html'`, '未登录跳转登录页');
  check('未登录访问首页跳转到 /login.html', true);
  const loginShot = await cdp.eval(`({hasForm: !!document.getElementById('login-form'), title: document.title})`);
  check('登录页表单渲染', loginShot.hasForm);
  await cdp.shot('01-login.png');

  // 错误密码
  await cdp.eval(`(async () => {
    document.getElementById('account').value = '15954896689';
    document.getElementById('password').value = 'wrongpwd';
    document.getElementById('login-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await cdp.waitFor(`document.getElementById('login-err').style.display === 'block'`, '错误提示显示');
  const errText = await cdp.eval(`document.getElementById('login-err').textContent`);
  check('错误密码提示正确', /不正确/.test(errText), errText);

  // ---------- 2. 主账号登录 ----------
  await cdp.eval(`(async () => {
    document.getElementById('account').value = '15954896689';
    document.getElementById('password').value = '789215';
    document.getElementById('login-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await cdp.waitFor(`location.pathname === '/index.html'`, '登录后进入首页', 60);
  await cdp.waitFor(`!!document.querySelector('.user-chip')`, '导航用户信息渲染');
  const nav = await cdp.eval(`({
    chip: document.querySelector('.user-chip').textContent.trim(),
    hasTeam: [...document.querySelectorAll('.header .nav a')].some(a => a.getAttribute('href') === '/team.html'),
    hasPerm: [...document.querySelectorAll('.header .nav a')].some(a => a.getAttribute('href') === '/permissions.html'),
    hasLogout: [...document.querySelectorAll('.header a')].some(a => /退出/.test(a.textContent)),
    stats: document.getElementById('stat-projects').textContent
  })`);
  check('导航显示主账号姓名「李白」', /李白/.test(nav.chip), nav.chip);
  check('导航显示「主账号」标识', /主账号/.test(nav.chip), nav.chip);
  check('主账号导航有「团队管理」入口', nav.hasTeam);
  check('主账号导航有「管理权限」入口', nav.hasPerm);
  check('导航有退出入口', nav.hasLogout);
  await cdp.shot('02-home-owner.png');

  // ---------- 3. 团队页 + 创建运营账号 ----------
  await cdp.goto(BASE + '/team.html');
  await cdp.waitFor(`document.querySelectorAll('.member').length > 0`, '团队页成员卡片渲染');
  const teamInfo = await cdp.eval(`({
    members: document.querySelectorAll('.member').length,
    hasCreateBtn: !!document.querySelector('#nu-submit'),
    ownerTag: document.querySelector('.member .badge') && document.querySelector('.member .badge').textContent.trim()
  })`);
  check('团队页渲染成员卡片', teamInfo.members >= 1, 'members=' + teamInfo.members);
  check('主账号标记为「主账号」', teamInfo.ownerTag === '主账号', teamInfo.ownerTag);

  // ---------- 3.1 管理权限页（主账号专属） ----------
  await cdp.goto(BASE + '/permissions.html');
  await cdp.waitFor(`document.querySelectorAll('.perm-row').length > 0`, '权限页成员权限行渲染');
  const permView = await cdp.eval(`({
    rows: document.querySelectorAll('.perm-row').length,
    switches: document.querySelectorAll('.perm-row .switch input[type=checkbox]').length,
    ownerLocked: document.querySelector('.perm-row.is-self input[type=checkbox]').disabled,
    nav: [...document.querySelectorAll('.header .nav a')].map(a => a.textContent),
    hasTable: !!document.querySelector('.perm-table')
  })`);
  check('管理权限页渲染成员权限行', permView.rows >= 1 && permView.switches >= 1, JSON.stringify(permView));
  check('管理权限页有权限对照表', permView.hasTable);
  check('主账号权限开关锁定不可改', permView.ownerLocked === true, String(permView.ownerLocked));
  await cdp.goto(BASE + '/team.html');
  await cdp.waitFor(`document.querySelectorAll('.member').length > 0`, '回到团队页');

  const suffix = Date.now().toString().slice(-5);
  const opName = '小张' + suffix;
  const opAccount = 'op' + suffix;
  await cdp.eval(`(() => {
    openCreate();
    document.getElementById('nu-username').value = ${JSON.stringify(opName)};
    document.getElementById('nu-account').value = ${JSON.stringify(opAccount)};
    document.getElementById('nu-password').value = 'op123456';
    return true;
  })()`);
  await cdp.shot('03-team-create.png');
  await cdp.eval(`createUser()`);
  await cdp.waitFor(`[...document.querySelectorAll('.mname')].some(e => e.textContent.includes(${JSON.stringify(opName)}))`, '新运营出现在列表', 60);
  const memberStats = await cdp.eval(`(() => {
    const card = [...document.querySelectorAll('.member')].find(c => c.querySelector('.mname').textContent.includes(${JSON.stringify(opName)}));
    return {
      name: card.querySelector('.mname').textContent.trim(),
      stats: [...card.querySelectorAll('.mstats b')].map(b => b.textContent),
      labels: [...card.querySelectorAll('.mstats span')].map(b => b.textContent),
      hasLookProjects: !!card.querySelector('a[href*="index.html?user="]')
    };
  })()`);
  check('新运营卡片显示四项今日统计', memberStats.stats.length === 4, JSON.stringify(memberStats.stats));
  check('统计标签为「今日新建项目/今日生成视频」', memberStats.labels.includes('今日新建项目') && memberStats.labels.includes('今日生成视频'), JSON.stringify(memberStats.labels));
  check('运营卡片有「看项目」入口', memberStats.hasLookProjects);
  await cdp.shot('04-team-list.png');

  // 主账号按运营筛选项目
  await cdp.goto(BASE + '/index.html');
  await cdp.waitFor(`!!document.querySelector('.user-chip')`, '回到首页');
  const opId = await cdp.eval(`(async () => {
    const r = await fetch('/api/team/overview'); const j = await r.json();
    const row = j.rows.find(x => (x.user.displayName||'').includes(${JSON.stringify(opName)}));
    return row ? row.user.id : '';
  })()`);
  check('能取到新运营的用户 ID', !!opId, opId);
  await cdp.goto(BASE + '/index.html?user=' + opId);
  await cdp.waitFor(`getComputedStyle(document.getElementById('scope-bar')).display !== 'none'`, '运营视角提示条');
  const scoped = await cdp.eval(`({bar: document.getElementById('scope-bar').textContent, title: document.querySelector('.page-title').textContent, projects: document.getElementById('stat-projects').textContent})`);
  check('主账号可按运营查看（提示条）', /正在查看运营/.test(scoped.bar), scoped.bar);
  check('运营项目数为 0', scoped.projects === '0', scoped.projects);
  await cdp.shot('05-owner-scoped.png');

  // ---------- 4. 子账号视角 ----------
  await cdp.eval(`(async () => { await fetch('/api/auth/logout', {method:'POST'}); })()`);
  await cdp.goto(BASE + '/login.html');
  await cdp.waitFor(`!!document.getElementById('login-form')`, '登录页');
  await cdp.eval(`(async () => {
    document.getElementById('account').value = ${JSON.stringify(opAccount)};
    document.getElementById('password').value = 'op123456';
    document.getElementById('login-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await cdp.waitFor(`location.pathname === '/index.html'`, '运营登录进入首页', 60);
  await cdp.waitFor(`!!document.querySelector('.user-chip')`, '导航渲染');
  const opView = await cdp.eval(`({
    chip: document.querySelector('.user-chip').textContent.trim(),
    hasTeam: [...document.querySelectorAll('.header .nav a')].some(a => a.getAttribute('href') === '/team.html'),
    hasPerm: [...document.querySelectorAll('.header .nav a')].some(a => a.getAttribute('href') === '/permissions.html'),
    projects: document.getElementById('stat-projects').textContent,
    cards: document.querySelectorAll('.project-card').length,
    emptyHint: document.getElementById('empty-hint') && getComputedStyle(document.getElementById('empty-hint')).display
  })`);
  check('运营导航显示「运营」身份', /运营/.test(opView.chip), opView.chip);
  check('运营导航没有「团队管理」入口', !opView.hasTeam);
  check('运营导航没有「管理权限」入口', !opView.hasPerm);
  check('运营看不到主账号项目（0 个）', opView.projects === '0' && opView.cards === 0, JSON.stringify(opView));
  await cdp.shot('06-home-operator.png');

  // 运营访问团队页应被弹回
  await cdp.goto(BASE + '/team.html');
  await sleep(1500);
  const teamRedirect = await cdp.eval(`location.pathname`);
  check('运营访问团队页被重定向回首页', teamRedirect === '/index.html', teamRedirect);

  // 运营访问管理权限页同样被弹回
  await cdp.goto(BASE + '/permissions.html');
  await sleep(1500);
  const permRedirect = await cdp.eval(`location.pathname`);
  check('运营访问管理权限页被重定向回首页', permRedirect === '/index.html', permRedirect);

  // 设置页已下线：导航里不再有「设置」；资料页可自助改密码；全局设置接口仍仅主账号可用
  const navHasSettings = await cdp.eval(`Array.from(document.querySelectorAll('.header .nav a')).some(a => ((a.getAttribute('href') || '')).includes('settings'))`);
  check('导航里不再有「设置」入口', navHasSettings === false, String(navHasSettings));

  await cdp.goto(BASE + '/profile.html');
  await cdp.waitFor(`!!document.getElementById('pwd-modal')`, '资料页加载');
  const pwdView = await cdp.eval(`(() => {
    openPwd();
    return {
      shown: document.getElementById('pwd-modal').classList.contains('show'),
      fields: ['oldPwd', 'newPwd', 'newPwd2'].every((id) => !!document.getElementById(id))
    };
  })()`);
  check('资料页能打开修改密码弹窗', pwdView.shown && pwdView.fields, JSON.stringify(pwdView));

  const setPost = await cdp.eval(`(async () => {
    const r = await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{"brandName":"hack"}'});
    return r.status;
  })()`);
  check('运营直接调全局设置接口返回 403', setPost === 403, 'code=' + setPost);
  await cdp.shot('07-profile-operator.png');

  // 清理：主账号登录后删除测试运营
  await cdp.eval(`(async () => { await fetch('/api/auth/logout', {method:'POST'}); })()`);
  await cdp.goto(BASE + '/login.html');
  await cdp.waitFor(`!!document.getElementById('login-form')`, '登录页');
  await cdp.eval(`(async () => {
    document.getElementById('account').value = '15954896689';
    document.getElementById('password').value = '789215';
    document.getElementById('login-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);
  await cdp.waitFor(`location.pathname === '/index.html'`, '主账号重新登录', 60);
  const cleanup = await cdp.eval(`(async () => {
    const r = await fetch('/api/team/users/${opId}', {method:'DELETE'});
    return (await r.json());
  })()`);
  check('测试运营账号已清理', cleanup && cleanup.ok, JSON.stringify(cleanup));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
