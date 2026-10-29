// test/ui-today.js - 验证首页两个统计卡片能一键跳转到聚合页（CDP 真实点击）
const http = require('http');
const CDP_PORT = process.env.CDP_PORT || 9333;
const BASE = 'http://localhost:3000';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
}

async function waitFor(cdp, expr, label, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await sleep(300);
    if (await cdp.eval(expr)) return true;
  }
  throw new Error('等待超时：' + label);
}

(async () => {
  let target = null;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === 'page' && t.url.includes('localhost:3000'));
      if (target) break;
    } catch (_) {}
    await sleep(500);
  }
  if (!target) throw new Error('未找到浏览器页面目标');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const results = [];

  // ---- 场景 1：点「今日新生成视频」 ----
  await cdp.send('Page.navigate', { url: `${BASE}/index.html` });
  await waitFor(cdp, `!!document.querySelector('a.stat-link')`, '首页统计卡片渲染');
  const linkInfo = await cdp.eval(`[...document.querySelectorAll('a.stat-link')].map(a=>({href:a.getAttribute('href'), label:a.querySelector('.label').textContent, more:!!a.querySelector('.more')}))`);
  console.log('① 可点击卡片:', JSON.stringify(linkInfo));

  await cdp.eval(`[...document.querySelectorAll('a.stat-link')].find(a=>a.href.includes('tab=videos')).click()`);
  await waitFor(cdp, `location.pathname === '/today.html'`, '跳转到今日视频页');
  await waitFor(cdp, `document.querySelectorAll('#video-grid .vcard').length > 0 || document.getElementById('video-empty').style.display === 'block'`, '今日视频列表加载');
  const v1 = await cdp.eval(`({
    url: location.pathname + location.search,
    title: document.getElementById('page-title').textContent,
    cards: document.querySelectorAll('#video-grid .vcard').length,
    count: document.getElementById('cnt-videos').textContent,
    hasVideoTag: !!document.querySelector('#video-grid video'),
    hasZipBtn: getComputedStyle(document.getElementById('zip-btn')).display !== 'none',
    firstMeta: (document.querySelector('.vcard .vmeta')||{}).textContent || ''
  })`);
  console.log('② 今日视频页:', JSON.stringify(v1));
  results.push(['首页卡片跳转到 /today.html?tab=videos', v1.url.includes('tab=videos')]);
  results.push(['页面标题正确', v1.title === '今日新生成视频']);
  results.push(['视频卡片数量与计数一致', String(v1.cards) === String(v1.count)]);
  results.push(['卡片内含可播放 video 元素', v1.hasVideoTag]);
  results.push(['显示 ZIP 打包按钮', v1.hasZipBtn]);

  // ---- 场景 2：切到「进行中任务」标签 ----
  await cdp.eval(`document.querySelector('.tab[data-tab="tasks"]').click()`);
  await waitFor(cdp, `document.getElementById('tab-tasks').classList.contains('active')`, '切换到任务标签');
  const v2 = await cdp.eval(`({
    url: location.pathname + location.search,
    title: document.getElementById('page-title').textContent,
    zipHidden: getComputedStyle(document.getElementById('zip-btn')).display === 'none',
    hasList: !!document.querySelector('#task-list') ,
    emptyShown: document.getElementById('task-empty').style.display === 'block',
    count: document.getElementById('cnt-tasks').textContent
  })`);
  console.log('③ 任务标签:', JSON.stringify(v2));
  results.push(['切换后 URL 带 tab=tasks', v2.url.includes('tab=tasks')]);
  results.push(['标题变为「进行中任务」', v2.title === '进行中任务']);
  results.push(['任务标签下隐藏 ZIP 按钮', v2.zipHidden]);
  results.push(['无任务时显示空态', v2.emptyShown || v2.count !== '0']);

  // ---- 场景 3：直接访问 ?tab=tasks 深链 ----
  await cdp.send('Page.navigate', { url: `${BASE}/today.html?tab=tasks` });
  await waitFor(cdp, `document.getElementById('tab-tasks').classList.contains('active')`, '深链直达任务标签');
  const v3 = await cdp.eval(`({active: document.querySelector('.tab.active').dataset.tab, title: document.getElementById('page-title').textContent})`);
  console.log('④ 深链:', JSON.stringify(v3));
  results.push(['?tab=tasks 深链直达任务标签', v3.active === 'tasks']);

  // ---- 场景 4：项目页 ?tab=results 深链 ----
  const projects = await getJson(`${BASE}/api/projects`);
  const pid = projects[0] && projects[0].id;
  if (pid) {
    await cdp.send('Page.navigate', { url: `${BASE}/project.html?id=${pid}&tab=results` });
    await waitFor(cdp, `!!document.querySelector('#tab-results.active')`, '项目页结果标签激活', 60);
    const v4 = await cdp.eval(`({active: (document.querySelector('.tab.active')||{}).textContent, hasGrid: !!document.getElementById('video-grid')})`);
    console.log('⑤ 项目页深链:', JSON.stringify(v4));
    results.push(['项目页 ?tab=results 直达视频结果', /视频结果/.test(v4.active || '')]);
  }

  console.log('\n=== 断言 ===');
  let pass = true;
  results.forEach(([n, ok]) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + n); if (!ok) pass = false; });
  console.log(pass ? '\n结论：入口跳转与聚合页均正常' : '\n结论：存在失败项');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e.message); process.exit(1); });
