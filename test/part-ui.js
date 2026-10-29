// 素材分类下拉（开头/片尾/材质/规格/讲解）UI 核对：需先起 Chrome --remote-debugging-port=9898
const fs = require('fs');
const path = require('path');

const PORT = 9898;
const BASE = 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', 'data', 'temp', 'shot');
const PID = process.argv[2] || 'prj_031ea6a4af51';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
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
    await c.send('Network.enable');
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'eval error');
    return r.result.value;
  }
  async shot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    return f;
  }
}

(async () => {
  const c = await CDP.attach();
  const errs = [];
  await c.send('Runtime.addBinding', { name: '__noop' }).catch(() => {});
  // 先登录拿 cookie，再注入
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '15954896689', password: '789215' }),
  });
  const sc = login.headers.get('set-cookie') || '';
  const sid = (sc.match(/sid=([^;]+)/) || [])[1];
  if (!sid) throw new Error('登录失败: ' + login.status);
  await c.send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });

  await c.send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` });
  await sleep(2500);
  await c.eval("document.querySelector('.tab[data-tab=\"inspect\"]').click()");
  await sleep(1200);
  // 打开第一条素材的剪辑面板以外，直接检查卡片
  const info = await c.eval(`(() => {
    const sels = [...document.querySelectorAll('.mat-part')];
    const cards = [...document.querySelectorAll('#inspect-grid .mat-card')];
    const s0 = sels[0];
    const cs = s0 ? getComputedStyle(s0) : null;
    const card = cards[0];
    // 是否横向溢出
    const overflow = cards.filter(c=>c.querySelector('.body').scrollWidth > c.querySelector('.body').clientWidth + 1).length;
    return {
      cards: cards.length,
      selects: sels.length,
      opts: s0 ? [...s0.options].map(o=>o.value||'(空)') : [],
      value: s0 ? s0.value : null,
      w: cs ? Math.round(s0.getBoundingClientRect().width) : 0,
      bodyW: card ? card.querySelector('.body').clientWidth : 0,
      overflowCards: overflow,
      chip: (document.getElementById('il-parts')||{}).textContent,
      hintHasPart: (document.getElementById('il-hint')||{}).textContent.includes('开头 / 片尾'),
    };
  })()`);
  console.log('INFO', JSON.stringify(info, null, 1));

  // 交互：把第 2 条素材选成「片尾」，看是否落库 + 统计更新
  const before = await c.eval(`document.querySelectorAll('.mat-part')[1].value`);
  await c.eval(`(() => {
    const s = document.querySelectorAll('.mat-part')[1];
    s.value = '片尾';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await sleep(900);
  const after = await c.eval(`(() => {
    const s = document.querySelectorAll('.mat-part')[1];
    return { value: s.value, has: s.classList.contains('has'), chip: document.getElementById('il-parts').textContent };
  })()`);
  console.log('CHANGE', before, '->', JSON.stringify(after));

  const shot = await c.shot('part-ui.png');
  console.log('SHOT', shot);

  const srv = await (await fetch(`${BASE}/api/projects/${PID}/inspect`, { headers: { Cookie: 'sid=' + sid } })).json();
  console.log('SERVER parts', srv.materials.map(m => m.part || '-').join(','));
  console.log('ERRORS', errs.length);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
