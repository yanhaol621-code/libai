// 字幕识别提速验证：进页面 → 切到「字幕识别」tab → 看状态文案 / 点识别 → 计时
const PORT = 9898, BASE = 'http://127.0.0.1:3000';
const PID = process.argv[2] || 'prj_031ea6a4af51';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description).join(' '));
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
  await ev(`document.querySelector('.tab[data-tab="asr"]').click()`);
  await sleep(2000);
  console.log('引擎文案:', await ev(`document.getElementById('asr-engine').textContent`));
  console.log('按钮:', await ev(`document.getElementById('asrBtn').textContent + ' disabled=' + document.getElementById('asrBtn').disabled`));

  // 勾选「重新识别」后点识别，等到状态变 done
  await ev(`(()=>{const c=document.getElementById('asr-force'); if(c&&!c.checked) c.click(); return true;})()`);
  const t0 = Date.now();
  await ev(`document.getElementById('asrBtn').click()`);
  let last = '';
  for (let i = 0; i < 200; i++) {
    last = await ev(`(document.getElementById('asp-status')||{}).textContent||''`);
    if (/完成|失败/.test(last)) break;
    await sleep(200);
  }
  console.log('识别状态:', last, ' 用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('倒计时:', await ev(`(document.getElementById('asp-eta')||{}).textContent||''`));
  console.log('JS ERRORS', errs.length, errs.slice(0, 3));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
