// 生成倒计时核对：喂假 SSE 事件，看两处「已用 / 预计剩余」是否真的在走
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
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
  };
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => { pend.set(i, { res, rej }); setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, 30000); }); };
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: '15954896689', password: '789215' }) });
  const sid = ((login.headers.get('set-cookie') || '').match(/sid=([^;]+)/) || [])[1];
  await send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' });
  await send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` });
  await sleep(2600);

  // ---- 一键美颜 ----
  await ev("document.querySelector('.tab[data-tab=\"beauty\"]').click()");
  await sleep(400);
  await ev(`(() => {
    const wrap=document.getElementById('beauty-progress'); wrap.style.display=''; wrap.classList.remove('done','error');
    document.getElementById('bp-log').innerHTML='';
    beautyEta = beautyEta || makeEta('bp-eta', { waitText:'正在启动…' });
    beautyEta.start();
    onBeautyEvent({type:'beauty',status:'running',progress:0,message:'开始美颜 1 个素材（适度）'});
  })()`);
  const b1 = await ev("document.getElementById('bp-eta').textContent");
  await sleep(1200);
  const b2 = await ev("document.getElementById('bp-eta').textContent");
  await ev(`onBeautyEvent({type:'beauty',status:'running',progress:40,message:'已完成 40%'})`);
  await sleep(300);
  const b3 = await ev("document.getElementById('bp-eta').textContent");
  await sleep(1200);
  await ev(`onBeautyEvent({type:'beauty',status:'running',progress:55,message:'已完成 55%'})`);
  await sleep(400);
  const b4 = await ev("document.getElementById('bp-eta').textContent");
  await sleep(1100);
  const b5 = await ev("document.getElementById('bp-eta').textContent");
  await ev(`onBeautyEvent({type:'beauty',status:'done',progress:100,message:'一键美颜完成：成功 1 个'})`);
  await sleep(300);
  const b6 = await ev("document.getElementById('bp-eta').textContent");
  console.log('BEAUTY');
  console.log('  t0      ', b1);
  console.log('  +1.2s   ', b2);
  console.log('  prog40  ', b3);
  console.log('  +1.1s   ', b4);
  console.log('  +2.2s   ', b5);
  console.log('  done    ', b6);
  const shotB = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('data/temp/shot/eta-beauty.png', Buffer.from(shotB.data, 'base64'));

  // ---- 字幕识别 ----
  await ev("document.querySelector('.tab[data-tab=\"asr\"]').click()");
  await sleep(400);
  await ev(`(() => {
    const wrap=document.getElementById('asr-progress'); wrap.style.display=''; wrap.classList.remove('done','error');
    document.getElementById('asp-log').innerHTML='';
    asrEta = asrEta || makeEta('asp-eta', { waitText:'模型加载中…' });
    asrEta.start();
    onAsrEvent({type:'asr',status:'running',progress:0,message:'开始识别 1 个素材（批量模式，模型只加载一次）'});
  })()`);
  const a1 = await ev("document.getElementById('asp-eta').textContent");
  await sleep(1200);
  const a2 = await ev("document.getElementById('asp-eta').textContent");
  await ev(`onAsrEvent({type:'asr',status:'running',progress:25,message:'识别中 25%'})`);
  await sleep(300);
  const a3 = await ev("document.getElementById('asp-eta').textContent");
  await sleep(1200);
  const a4 = await ev("document.getElementById('asp-eta').textContent");
  const shotA = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('data/temp/shot/eta-asr.png', Buffer.from(shotA.data, 'base64'));
  await ev(`onAsrEvent({type:'asr',status:'done',progress:100,message:'口播字幕识别完成'})`);
  await sleep(300);
  const a5 = await ev("document.getElementById('asp-eta').textContent");
  console.log('ASR');
  console.log('  t0      ', a1);
  console.log('  +1.2s   ', a2);
  console.log('  prog25  ', a3);
  console.log('  +1.2s   ', a4);
  console.log('  done    ', a5);
  console.log('JS ERRORS', errs.length, errs.slice(0, 3));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
