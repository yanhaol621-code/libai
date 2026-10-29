// 实时字幕预览（veUpdatePreview）UI 核对：Chrome --remote-debugging-pipe（绕开本机透明代理拦 TCP 的问题）
// 验证点：
//  1. veOpen 后预览层出现且定位在画面内容区（letterbox 感知）
//  2. 拖动字号/位置滑条 → 预览字号与 top 即时变化（无需重渲）
//  3. 改字幕色/描边色 → 预览 color/textShadow 即时变化
//  4. seek 后按时间轴取到当前段的字幕文本
//  5. 全程无 JS 报错
const path = require('path');
const { spawn } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:3000';
const PID = process.argv[2] || 'prj_308436a32a46';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— CDP over pipe（fd3 写 / fd4 读，消息以 \0 结尾）——
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
    // 子会话事件（暂不用事件，忽略）
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
  const errors = [];
  const cdp = new PipeCDP(); cdp.start();
  await sleep(1500);
  await cdp.attachPage('about:blank');

  // 登录拿 sid → 注入 Cookie（页面有账号门槛）
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
  const vid = await cdp.eval(`(project.videos||[])[0] && project.videos[0].id`);
  if (!vid) { cdp.kill(); throw new Error('该项目没有成片，无法测试'); }
  console.log('video id:', vid);

  await cdp.eval(`veOpen('${vid}')`);
  await sleep(1500);

  // 1) 预览层可见 & 定位在画面内
  const st1 = await cdp.eval(`(()=>{
    const pv=document.getElementById('ve-preview'), box=document.getElementById('ve-video');
    const r=box.getBoundingClientRect(), p=pv.getBoundingClientRect();
    return {shown: pv.style.display==='block', tip: document.getElementById('ve-preview-tip').style.display,
            txt: pv.textContent, fs: pv.style.fontSize,
            inX: p.left>=r.left-1 && p.right<=r.right+1,
            inY: p.top>=r.top-2 && p.bottom<=r.bottom+2};
  })()`);
  console.log('初始预览:', JSON.stringify(st1));
  if (!st1.inX || !st1.inY) errors.push('预览层超出视频画面范围');
  if (st1.shown && st1.tip !== 'block') errors.push('提示角标未显示');

  // 2) 拖滑条 → 即时变化
  const before = await cdp.eval(`({fs: parseFloat(document.getElementById('ve-preview').style.fontSize)||0, top: document.getElementById('ve-preview').style.top})`);
  await cdp.eval(`document.getElementById('ve-size').value=0.07; document.getElementById('ve-size').dispatchEvent(new Event('input'));`);
  await cdp.eval(`document.getElementById('ve-pos').value=0.5; document.getElementById('ve-pos').dispatchEvent(new Event('input'));`);
  const after = await cdp.eval(`({fs: parseFloat(document.getElementById('ve-preview').style.fontSize)||0, top: document.getElementById('ve-preview').style.top, label: document.getElementById('ve-size-v').textContent})`);
  console.log(`字号 ${before.fs} → ${after.fs}px | top ${before.top} → ${after.top}`);
  if (!(after.fs > before.fs * 1.3)) errors.push('字号滑条未即时生效');
  if (after.top === before.top) errors.push('位置滑条未即时生效');
  if (!/7(\.0)?%/.test(after.label)) errors.push('字号数值标签未更新');

  // 3) 颜色即时生效
  await cdp.eval(`document.getElementById('ve-color').value='#ffff00'; document.getElementById('ve-color').dispatchEvent(new Event('input'));`);
  await cdp.eval(`document.getElementById('ve-outline').value='#ff0000'; document.getElementById('ve-outline').dispatchEvent(new Event('input'));`);
  const col = await cdp.eval(`({c: document.getElementById('ve-preview').style.color, s: document.getElementById('ve-preview').style.textShadow})`);
  console.log('颜色:', col.c, '| 描边含红:', /rgb\(255, 0, 0\)/.test(col.s));
  if (!/255, 255, 0/.test(col.c)) errors.push('字幕色未即时生效');
  if (!/rgb\(255, 0, 0\)/.test(col.s)) errors.push('描边色未即时生效');

  // 4) seek 到第一段中部 → 取到字幕文本
  const t2 = await cdp.eval(`(async()=>{
    const v=(project.videos||[]).find(x=>x.id===curVeVid);
    const wins=segTimeWindows(v.segments||[]);
    const mid=(wins[0].start+wins[0].end)/2;
    const box=document.getElementById('ve-video');
    box.currentTime=mid;
    await new Promise(r=>{box.addEventListener('seeked',r,{once:true}); setTimeout(r,2000);});
    veUpdatePreview();
    return {t: mid, txt: document.getElementById('ve-preview').textContent, shown: document.getElementById('ve-preview').style.display};
  })()`);
  console.log('seek 后:', JSON.stringify(t2));
  if (!t2.txt) errors.push('seek 后预览没有字幕文本');
  if (t2.shown !== 'block') errors.push('seek 后预览层未显示');

  // 5) 页面报错
  const errs = await cdp.eval(`window.__errs`);
  if (errs.length) errors.push('页面 JS 报错: ' + errs.join('; '));

  await cdp.eval(`veClose()`);
  cdp.kill();
  console.log(errors.length ? 'FAIL:\n- ' + errors.join('\n- ') : 'PASS：实时预览全部通过');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('TEST ERROR:', e.message); process.exit(2); });
