// 剪刀工具 + 撤回（Ctrl+Z）UI 核对：需先起 Chrome --remote-debugging-port=9898
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
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'eval error');
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
  await c.send('Runtime.enable');
  c.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map((a) => a.value || a.description).join(' '));
  });
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '15954896689', password: '789215' }),
  });
  const sid = ((login.headers.get('set-cookie') || '').match(/sid=([^;]+)/) || [])[1];
  if (!sid) throw new Error('登录失败: ' + login.status);
  await c.send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });

  await c.send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` });
  await sleep(2600);
  await c.eval("document.querySelector('.tab[data-tab=\"inspect\"]').click()");
  await sleep(1200);

  const mid = await c.eval(`(() => {
    const p = project.materials.find(m => m.type === 'video' && !m.excluded);
    if (!p) return null;
    openMatEditor(p.id);
    return p.id;
  })()`);
  if (!mid) throw new Error('没有视频素材');
  // 等视频元数据（面板里才有真实时长）
  for (let i = 0; i < 40; i++) {
    const ok = await c.eval(`(() => { const v = document.getElementById('mev'); return !!(v && v.duration && v.duration > 0.5 && document.getElementById('metimeline')); })()`);
    if (ok) break;
    await sleep(300);
  }
  await sleep(800);

  const base = await c.eval(`(() => ({
    pieces: edState.pieces.map(p => [ +p.t0.toFixed(2), +p.in.toFixed(2), +p.out.toFixed(2), p.v, p.a ]),
    dur: +edState.dur.toFixed(2),
    undo: edUndo.length,
    undoBtn: (document.getElementById('mep-undo') || {}).textContent,
    undoDisabled: (document.getElementById('mep-undo') || {}).disabled,
    btns: [...document.querySelectorAll('#mep-btns .btn')].map(b => b.textContent.trim()),
  }))()`);
  console.log('BASE', JSON.stringify(base));

  // 1) 开剪刀
  await c.eval(`document.getElementById('mep-scissor').click()`);
  await sleep(300);
  console.log('SCISSOR ON', JSON.stringify(await c.eval(`(() => ({
    cut: edState.cut,
    cls: document.getElementById('metimeline').classList.contains('cut-mode'),
    label: document.getElementById('mep-scissor').textContent,
    cursor: getComputedStyle(document.querySelector('#metimeline .me-bar')).cursor.slice(0, 24),
  }))()`)));

  // 2) 悬停预览切线
  await c.eval(`(() => {
    const bar = document.querySelector('#metimeline .me-bar[data-kind="v"][data-lane="0"]');
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * 0.55, clientY: r.top + r.height / 2, bubbles: true }));
  })()`);
  console.log('HOVER', JSON.stringify(await c.eval(`(() => {
    const g = document.querySelector('.me-cutline');
    return g ? { shown: g.style.display, left: Math.round(parseFloat(g.style.left)), text: g.textContent, bad: g.classList.contains('bad') } : null;
  })()`)));

  // 3) 点画面轨切开
  await c.eval(`(() => {
    const bar = document.querySelector('#metimeline .me-bar[data-kind="v"][data-lane="0"]');
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.55, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  })()`);
  await sleep(900);
  const afterCut = await c.eval(`(() => ({
    pieces: edState.pieces.map(p => [ +p.t0.toFixed(2), +p.in.toFixed(2), +p.out.toFixed(2), p.v, p.a ]),
    undo: edUndo.map(x => x.label),
    undoBtn: (document.getElementById('mep-undo') || {}).textContent,
    els: document.querySelectorAll('#metimeline .me-bar[data-kind="v"][data-lane="0"] .me-piece').length,
    toast: (document.querySelector('.toast') || {}).textContent || '',
  }))()`);
  console.log('CUT', JSON.stringify(afterCut));

  // 4) 撤回（Ctrl+Z）
  await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true }))`);
  await sleep(1200);
  const afterUndo = await c.eval(`(() => ({
    pieces: edState.pieces.map(p => [ +p.t0.toFixed(2), +p.in.toFixed(2), +p.out.toFixed(2), p.v, p.a ]),
    undo: edUndo.length,
    undoBtn: (document.getElementById('mep-undo') || {}).textContent,
    disabled: (document.getElementById('mep-undo') || {}).disabled,
    toast: (document.querySelector('.toast') || {}).textContent || '',
  }))()`);
  console.log('UNDO', JSON.stringify(afterUndo));
  const same = JSON.stringify(afterUndo.pieces) === JSON.stringify(base.pieces);
  console.log('UNDO 还原一致?', same);

  // 5) 音频轨切刀
  await c.eval(`(() => {
    const bar = document.querySelector('#metimeline .me-bar[data-kind="a"][data-lane="0"]');
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.3, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  })()`);
  await sleep(900);
  console.log('AUDIO CUT', JSON.stringify(await c.eval(`(() => ({
    pieces: edState.pieces.length,
    undo: edUndo.map(x => x.label),
    toast: (document.querySelector('.toast') || {}).textContent || '',
  }))()`)));
  await c.eval(`document.getElementById('mep-undo').click()`);
  await sleep(900);

  // 6) 关剪刀后再点轨道 = 正常跳播，不再切
  await c.eval(`document.getElementById('mep-scissor').click()`);
  await sleep(200);
  const beforeSeek = await c.eval(`edState.pieces.length`);
  await c.eval(`(() => {
    const bar = document.querySelector('#metimeline .me-bar[data-kind="v"][data-lane="0"]');
    const r = bar.getBoundingClientRect();
    bar.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width * 0.42, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  })()`);
  await sleep(500);
  console.log('CUT OFF', JSON.stringify(await c.eval(`({ pieces: edState.pieces.length, cut: edState.cut, playT: +edPlayT.toFixed(2) })`)), 'before', beforeSeek);

  // 7) 拖动片段 → 撤回
  const dragBefore = await c.eval(`edState.pieces.map(p => +p.t0.toFixed(2))`);
  await c.eval(`(() => {
    const el = document.querySelector('#metimeline .me-bar[data-kind="v"][data-lane="0"] .me-piece');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width / 2 + 42, clientY: r.top + r.height / 2, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + r.width / 2 + 42, clientY: r.top + r.height / 2, bubbles: true }));
  })()`);
  await sleep(800);
  const dragged = await c.eval(`({ t0s: edState.pieces.map(p => +p.t0.toFixed(2)), undo: edUndo.map(x => x.label) })`);
  await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true }))`);
  await sleep(900);
  const dragUndone = await c.eval(`edState.pieces.map(p => +p.t0.toFixed(2))`);
  console.log('DRAG', JSON.stringify(dragBefore), '->', JSON.stringify(dragged), '撤销后', JSON.stringify(dragUndone));

  // 8) 删除本段 → 撤回
  const delBefore = await c.eval(`({ n: edState.pieces.length, sel: edState.sel })`);
  await c.eval(`edDelPiece()`);
  await sleep(800);
  const delAfter = await c.eval(`({ n: edState.pieces.length, undo: edUndo.map(x => x.label) })`);
  await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'z', code:'KeyZ', ctrlKey:true, bubbles:true, cancelable:true }))`);
  await sleep(900);
  const delUndo = await c.eval(`({ n: edState.pieces.length, toast: (document.querySelector('.toast') || {}).textContent || '' })`);
  console.log('DELETE', JSON.stringify(delBefore), '->', JSON.stringify(delAfter), '撤销后', JSON.stringify(delUndo));

  // 9) 连续撤回：栈空时按钮禁用
  await c.eval(`(async () => { await edUndoStep(); })()`);
  await sleep(600);
  console.log('STACK', JSON.stringify(await c.eval(`({ undo: edUndo.length, disabled: document.getElementById('mep-undo').disabled })`)));

  console.log('SHOT', await c.shot('cut-undo-ui.png').catch((e) => 'shot fail: ' + e.message));
  const srv = await (await fetch(`${BASE}/api/projects/${PID}`, { headers: { Cookie: 'sid=' + sid } })).json();
  const sm = srv.materials.find((m) => m.id === mid);
  console.log('SERVER pieces', JSON.stringify(sm.pieces || null));
  console.log('ERRORS', errs.length, errs.slice(0, 3).join(' | '));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
