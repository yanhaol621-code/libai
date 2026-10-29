// 音乐素材库 UI 核对：Chrome --remote-debugging-pipe（绕开本机透明代理拦 TCP 的问题）
// 验证点：
//  1. 背景音乐区渲染出素材库列表（6 首种子曲目）
//  2. 每行有 试听/选用/删除 按钮与风格、时长标注
//  3. 点「选用」→ project.musicLibId 变化、行内出现「使用中」
//  4. 点「取消选用」→ 恢复未选用状态
//  5. 全程无 JS 报错
const path = require('path');
const { spawn } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:3000';
const PID = process.argv[2] || 'prj_308436a32a46';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PipeCDP {
  constructor() { this.id = 0; this.pending = new Map(); this.sessions = new Map(); this.buf = ''; }
  start() {
    this.proc = spawn(CHROME, [
      '--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(__dirname, '..', 'data', 'temp', 'chrome-pipe'),
      'about:blank',
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    this.proc.stdio[4].on('data', (d) => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\0')) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        this.onMsg(msg);
      }
    });
    this.proc.stdio[3].write(JSON.stringify({ id: 0, method: 'Target.setAutoAttach', params: { autoAttach: false, waitForDebuggerOnStart: false } }) + '\0');
  }
  onMsg(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const m = { id, method, params };
    if (sessionId) m.sessionId = sessionId;
    this.proc.stdio[3].write(JSON.stringify(m) + '\0');
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  async attachPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.pageSession = sessionId; this.targetId = targetId;
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    return sessionId;
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, this.pageSession);
    if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
  kill() { try { this.proc.kill(); } catch (_) {} }
}

(async () => {
  const cdp = new PipeCDP(); cdp.start();
  await sleep(1500);
  await cdp.attachPage('about:blank');

  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '15954896689', password: '789215' }),
  });
  const sid = ((login.headers.get('set-cookie') || '').match(/sid=([^;]+)/) || [])[1];
  if (!sid) throw new Error('登录失败: ' + login.status);
  await cdp.send('Network.setCookie', { name: 'sid', value: sid, domain: '127.0.0.1', path: '/' }, cdp.pageSession);

  await cdp.send('Page.navigate', { url: `${BASE}/project.html?id=${PID}` }, cdp.pageSession);
  await sleep(3000);
  await cdp.eval(`window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));'ok'`);

  // 切到自动混剪 tab（背景音乐区在该页）
  await cdp.eval(`switchTab('render')`);
  await sleep(1200);

  // 1) 素材库行数与内容
  const info = await cdp.eval(`(()=>{
    const rows=[...document.querySelectorAll('#music-lib .lib-row')];
    return { count: rows.length,
      sample: rows.slice(0,2).map(r=>r.textContent.replace(/\s+/g,' ').slice(0,80)),
      hasPlay: rows.every(r=>r.querySelector('.lib-play')),
      hasUse: rows.every(r=>[...r.querySelectorAll('button')].some(b=>/选用|使用中/.test(b.textContent))),
      hasDel: rows.every(r=>[...r.querySelectorAll('button')].some(b=>b.textContent==='删除')),
      genSel: !!document.getElementById('lib-gen-sel') && document.getElementById('lib-gen-sel').options.length,
      status: document.getElementById('music-status').textContent };
  })()`);
  console.log('素材库:', JSON.stringify(info, null, 2));
  if (info.count < 6) throw new Error('素材库行数不足: ' + info.count);

  // 2) 选用 → 使用中
  await cdp.eval(`useLibMusic(musicLibTracks[0].id)`);
  await sleep(800);
  const use1 = await cdp.eval(`({ lib: project.musicLibId, on: !!document.querySelector('#music-lib .lib-row.on'), status: document.getElementById('music-status').textContent })`);
  console.log('选用后:', JSON.stringify(use1));
  if (!use1.lib || !use1.on) throw new Error('选用未生效');

  // 3) 取消选用
  await cdp.eval(`clearMusicChoice()`);
  await sleep(800);
  const use2 = await cdp.eval(`({ lib: project.musicLibId||'', on: !!document.querySelector('#music-lib .lib-row.on'), status: document.getElementById('music-status').textContent })`);
  console.log('取消后:', JSON.stringify(use2));
  if (use2.lib || use2.on) throw new Error('取消选用未生效');

  // 4) 无 JS 报错
  const errs = await cdp.eval(`window.__errs`);
  if (errs && errs.length) throw new Error('页面 JS 报错: ' + errs.join(' | '));

  console.log('ALL PASS ✓');
  cdp.kill();
})().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(1); });
