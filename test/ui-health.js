// 全站页面健康检查：控制台报错 + 关键元素是否存在
const path = require('path');
const PORT = 9333;
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      events.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      events.push('CONSOLE: ' + m.params.args.map((a) => a.value || a.description || '').join(' '));
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      events.push('LOG: ' + m.params.entry.text);
    }
  };
  const send = (method, params = {}) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 30000); });
  };
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 900, deviceScaleFactor: 1, mobile: false });

  // 登录
  await send('Page.navigate', { url: BASE + '/login.html' });
  await sleep(1200);
  await evalJs(`fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:'15954896689',password:'789215'})}).then(r=>r.status)`);

  const pid = await evalJs(`fetch('/api/projects').then(r=>r.json()).then(a=>a[0]&&a[0].id||'')`);

  const pages = [
    ['index.html', `/index.html`, `!!document.getElementById('stat-projects') && document.querySelectorAll('.project-card').length>=0`],
    ['create.html', `/create.html`, `!!document.getElementById('duration')`],
    ['today-videos', `/today.html?tab=videos`, `document.querySelectorAll('.tab').length===2`],
    ['today-tasks', `/today.html?tab=tasks`, `!!document.querySelector('.tab.active')`],
    ['team.html', `/team.html`, `!!document.getElementById('member-list')`],
    ['permissions.html', `/permissions.html`, `document.querySelectorAll('.perm-row').length>0 && !!document.querySelector('.perm-table')`],
    ['profile.html', `/profile.html`, `!!document.getElementById('pf-avatar') && document.getElementById('pf-username').textContent.length > 0 && document.querySelectorAll('.ladder-item').length === 13`],
    ['chat.html', `/chat.html`, `document.querySelectorAll('.peer').length > 0 && !!document.getElementById('chat-list')`],
    ['chat-audit.html', `/chat-audit.html`, `!!document.getElementById('audit-list') && document.querySelectorAll('.audit-kpi').length === 4`],
    ['project-upload', `/project.html?id=${pid}&tab=upload`, `document.getElementById('proj-meta').children.length>=5 && !!document.querySelector('.proj-title')`],
    ['project-analysis', `/project.html?id=${pid}&tab=analysis`, `document.querySelectorAll('.mat-card').length>0`],
    ['project-results', `/project.html?id=${pid}&tab=results`, `document.querySelectorAll('.video-card').length>0`],
    ['project-library', `/project.html?id=${pid}&tab=library`, `!!document.getElementById('lib-grid')`],
  ];

  let fail = 0;
  for (const [name, url, probe] of pages) {
    events.length = 0;
    await send('Page.navigate', { url: BASE + url });
    await sleep(2400);
    const ok = await evalJs(probe);
    const thumbs = name.includes('project') ? await evalJs(`(()=>{const a=[...document.querySelectorAll('.mat-card img,.video-card img')];return a.filter(i=>i.complete&&i.naturalWidth>0).length+'/'+a.length})()`) : '-';
    const errs = events.filter((e) => !/favicon|ERR_BLOCKED|net::/i.test(e));
    const status = ok && !errs.length ? 'PASS' : (ok ? 'WARN' : 'FAIL');
    if (status === 'FAIL') fail++;
    console.log(`${status}  ${name.padEnd(18)} probe=${ok} imgs=${thumbs}${errs.length ? ' errs=' + JSON.stringify(errs.slice(0, 2)) : ''}`);
  }
  console.log(fail ? `\n${fail} 个页面有问题` : '\n全部页面通过');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
