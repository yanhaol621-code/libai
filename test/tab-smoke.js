// 各标签页冒烟：切一遍 tab，收集 JS 报错
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
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000); }); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: '15954896689', password: '789215' }) });
  const sid = ((login.headers.get('set-cookie') || '').match(/sid=([^;]+)/) || [])[1];
  await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });

  await send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` });
  await sleep(2500);
  errs.length = 0;
  const tabs = await ev("[...document.querySelectorAll('.tab')].map(t=>t.dataset.tab)");
  console.log('tabs', tabs.join(','));
  for (const t of tabs) {
    await ev(`document.querySelector('.tab[data-tab="${t}"]').click()`);
    await sleep(700);
    const info = await ev(`(()=>{const c=document.querySelector('#tab-${t}');return {vis:!!c && getComputedStyle(c).display!=='none', scroll:document.documentElement.scrollWidth>window.innerWidth+1};})()`);
    console.log(' tab', t, JSON.stringify(info));
  }
  console.log('JS ERRORS', errs.length, errs.slice(0, 5));
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
