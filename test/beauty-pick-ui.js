// 一键美颜勾选交互验证：勾选框渲染 / 计数 / 全选全不选 / 取消勾选时的二次确认
const fs = require('fs');
const PORT = 9898, BASE = 'http://127.0.0.1:3000';
const PID = process.argv[2] || 'prj_031ea6a4af51';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errs = [];
  let dialogAsked = 0, dialogAccept = false;
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogAsked++;
      send('Page.handleJavaScriptDialog', { accept: dialogAccept });
    }
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  };
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 60000); }); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: '15954896689', password: '789215' }) });
  const sid = ((login.headers.get('set-cookie') || '').match(/sid=([^;]+)/) || [])[1];
  await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });

  await send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` });
  await sleep(3000);
  errs.length = 0;
  await ev(`document.querySelector('.tab[data-tab="beauty"]').click()`);
  await sleep(1500);

  console.log('标题:', await ev(`document.getElementById('bl-title').textContent`));
  console.log('按钮:', await ev(`document.getElementById('beautyBtn').textContent + ' disabled=' + document.getElementById('beautyBtn').disabled`));
  console.log('勾选框数量:', await ev(`document.querySelectorAll('#beauty-grid .mat-pick').length`),
    ' 已勾选:', await ev(`document.querySelectorAll('#beauty-grid .mat-pick input:checked').length`));

  // 1) 取消勾选已美颜的素材：应弹二次确认，选择「取消」→ 状态不变
  dialogAccept = false;
  await ev(`(()=>{const c=document.querySelector('#beauty-grid .mat-pick input:checked'); c.click(); return true;})()`);
  await sleep(1200);
  console.log('取消勾选(取消弹窗) 后：弹窗次数', dialogAsked,
    ' 已勾选', await ev(`document.querySelectorAll('#beauty-grid .mat-pick input:checked').length`),
    ' 按钮', await ev(`document.getElementById('beautyBtn').textContent`));

  // 2) 全不选 → 弹窗，选择「取消」
  const before = dialogAsked;
  await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='全不选').click()`);
  await sleep(1000);
  console.log('全不选(取消弹窗) 后：新弹窗', dialogAsked - before, ' 已勾选', await ev(`document.querySelectorAll('#beauty-grid .mat-pick input:checked').length`));

  // 3) 截图看排版
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('data/temp/beauty_pick_ui.png', Buffer.from(shot.data, 'base64'));
  console.log('截图: data/temp/beauty_pick_ui.png');
  console.log('JS ERRORS', errs.length, errs.slice(0, 3));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
