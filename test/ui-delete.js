// test/ui-delete.js - 通过 Chrome DevTools Protocol 验证首页「删除项目」按钮的真实行为
const http = require('http');

const CDP_PORT = process.env.CDP_PORT || 9333;
const BASE = 'http://localhost:3000';

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    });
    return c;
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const i = ++this.id;
      this.pending.set(i, resolve);
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  }
}

(async () => {
  // 1. 造一个专门用于删除测试的项目
  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'UI删除测试项目', category: '包装盒', ratio: '9:16', duration: 15, count: 1, style: '产品实拍展示' }),
  }).then((r) => r.json());
  console.log('① 创建测试项目:', created.id, created.name);

  // 2. 连接无头浏览器页面
  let target = null;
  for (let i = 0; i < 30; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === 'page' && t.url.includes('localhost:3000'));
      if (target) break;
    } catch (_) {}
    await sleep(500);
  }
  if (!target) throw new Error('未找到浏览器页面目标，请确认 Chrome 已带 --remote-debugging-port 启动');
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 3. 回到首页并等待卡片渲染完成
  await cdp.send('Page.navigate', { url: `${BASE}/index.html` });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    ready = await cdp.eval(`document.querySelectorAll('.project-card').length > 0 && !!document.querySelector('.project-card .del-btn')`);
    if (ready) break;
  }
  if (!ready) throw new Error('首页项目卡片或删除按钮未渲染');

  const before = await cdp.eval(`({
    cards: document.querySelectorAll('.project-card').length,
    buttons: document.querySelectorAll('.project-card .del-btn').length,
    names: [...document.querySelectorAll('.project-card .name')].map(e=>e.textContent.trim()),
    url: location.pathname
  })`);
  console.log('② 删除前:', JSON.stringify(before));

  // 4. 点击「UI删除测试项目」卡片的删除按钮（自动确认弹窗）
  const clicked = await cdp.eval(`(() => {
    window.confirm = () => true;
    const card = [...document.querySelectorAll('.project-card')]
      .find(c => c.querySelector('.name') && c.querySelector('.name').textContent.includes('UI删除测试项目'));
    if (!card) return 'card-not-found';
    const btn = card.querySelector('.del-btn');
    if (!btn) return 'btn-not-found';
    btn.click();
    return 'clicked';
  })()`);
  console.log('③ 点击删除按钮:', clicked);
  if (clicked !== 'clicked') throw new Error('未能点击删除按钮: ' + clicked);

  // 5. 等待列表刷新
  let after = null;
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    after = await cdp.eval(`({
      cards: document.querySelectorAll('.project-card').length,
      names: [...document.querySelectorAll('.project-card .name')].map(e=>e.textContent.trim()),
      toast: (document.querySelector('.toast')||{}).textContent || '',
      url: location.pathname
    })`);
    if (!after.names.some((n) => n.includes('UI删除测试项目'))) break;
  }
  console.log('④ 删除后:', JSON.stringify(after));

  // 6. 通过 API 复核项目是否真的删除
  const remaining = await getJson(`${BASE}/api/projects`);
  const stillThere = remaining.some((p) => p.id === created.id);
  console.log('⑤ API 复核: 项目是否仍存在 =', stillThere, '| 剩余项目数 =', remaining.length);

  const checks = [
    ['删除按钮已渲染 (' + after.buttons + ')', before.buttons === before.cards],
    ['卡片数量减少 1', after.cards === before.cards - 1],
    ['目标项目卡片已消失', !after.names.some((n) => n.includes('UI删除测试项目'))],
    ['未误跳转到项目详情页', after.url.endsWith('/index.html')],
    ['出现成功提示', /删除/.test(after.toast)],
    ['后端已删除该记录', !stillThere],
  ];
  console.log('\n=== 断言 ===');
  let pass = true;
  checks.forEach(([name, ok]) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name); if (!ok) pass = false; });
  console.log(pass ? '\n结论：UI 删除功能正常' : '\n结论：存在失败项');
  process.exit(pass ? 0 : 1);
})().catch(async (e) => {
  console.error('测试异常:', e.message);
  process.exit(1);
});
