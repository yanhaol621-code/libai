// 新版界面截图核对脚本（需先启动 Chrome: --remote-debugging-port=9333）
const fs = require('fs');
const path = require('path');

const PORT = 9333;
const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'data', 'temp', 'shot');
const OWNER = { account: '15954896689', password: '789215' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null; }
  static async attach() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  async goto(url, wait = 2600) {
    await this.send('Page.navigate', { url });
    await sleep(wait);
    await this.eval('window.scrollTo(0,0)');
    await sleep(350);
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.value;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, name + '.png');
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log('  shot ->', p);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cdp = await CDP.attach();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1) 登录
  await cdp.goto(BASE + '/login.html', 1500);
  await cdp.shot('n1-login');
  await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({account:'${OWNER.account}', password:'${OWNER.password}'}) });
    return (await r.json()).ok || r.status;
  })()`);
  console.log('  logged in');

  // 2) 首页
  await cdp.goto(BASE + '/index.html', 3000);
  await cdp.shot('n2-home');

  // 3) 团队页
  await cdp.goto(BASE + '/team.html', 2800);
  await cdp.shot('n3-team');

  // 3.1) 管理权限页
  await cdp.goto(BASE + '/permissions.html', 2400);
  await cdp.shot('n3b-permissions');

  // 3.2) 我的资料（头像 / 职级 / 编辑资料）
  await cdp.goto(BASE + '/profile.html', 2400);
  await cdp.shot('n3c-profile');

  // 4) 今日数据（两个标签）
  await cdp.goto(BASE + '/today.html?tab=videos', 2800);
  await cdp.shot('n4-today-videos');
  await cdp.goto(BASE + '/today.html?tab=tasks', 2400);
  await cdp.shot('n5-today-tasks');

  // 5) 新建项目
  await cdp.goto(BASE + '/create.html', 1800);
  await cdp.shot('n6-create');

  // 6) 我的资料
  await cdp.goto(BASE + '/profile.html', 2000);
  await cdp.shot('n7-profile');

  // 7) 项目工作台（取第一个项目）
  const pid = await cdp.eval(`(async () => {
    const r = await fetch('/api/projects'); const a = await r.json();
    return (a[0] && a[0].id) || '';
  })()`);
  if (pid) {
    await cdp.goto(`${BASE}/project.html?id=${pid}&tab=upload`, 3000);
    await cdp.shot('n8-project-upload');
    await cdp.goto(`${BASE}/project.html?id=${pid}&tab=analysis`, 3200);
    await cdp.shot('n9-project-analysis');
  } else {
    console.log('  没有项目，跳过项目页');
  }

  console.log('done');
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
