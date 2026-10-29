// 真实美颜跑一遍，验证「进度是否细、倒计时是否线性」
const http = require('http');
const fs = require('fs');
const path = require('path');

const cookie = fs.readFileSync('/tmp/tok.txt', 'utf8');
const PID = process.argv[2] || 'prj_031ea6a4af51';
const MID = process.argv[3] || 'mat_aa2f3f681376';

const req = (method, p, obj) => new Promise((res, rej) => {
  const body = obj ? JSON.stringify(obj) : null;
  const r = http.request({ host: '127.0.0.1', port: 3000, path: p, method, headers: Object.assign({ Cookie: cookie }, body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) }, (x) => {
    let d = ''; x.on('data', (c) => d += c); x.on('end', () => res({ code: x.statusCode, body: d }));
  });
  r.on('error', rej); if (body) r.write(body); r.end();
});

(async () => {
  // 备份现有美颜副本，测完照原样放回（避免留下测试产物）
  const beautyPath = path.join(__dirname, '..', 'data', 'projects', PID, 'materials', 'beauty', MID + '.mp4');
  const bak = beautyPath + '.bak';
  if (fs.existsSync(beautyPath)) { fs.copyFileSync(beautyPath, bak); console.log('备份 →', path.basename(bak), (fs.statSync(bak).size / 1e6).toFixed(1) + 'MB'); }

  const t0 = Date.now();
  let last = -1;
  const rows = [];
  // SSE 订阅
  const sr = http.request({ host: '127.0.0.1', port: 3000, path: `/api/projects/${PID}/stream`, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let d; try { d = JSON.parse(line.slice(5)); } catch (_) { continue; }
        if (d.type !== 'beauty') continue;
        const sec = (Date.now() - t0) / 1000;
        rows.push({ sec, p: d.progress, msg: d.message });
      }
    });
  });
  sr.end();

  await new Promise((r) => setTimeout(r, 300));
  const r = await req('POST', `/api/projects/${PID}/beauty`, { ids: [MID], preset: 'mild' });
  console.log('POST /beauty', r.code, r.body);

  // 等结束，同时盯着产物文件何时落地（判断兜底封装花了多久）
  let fileAt = 0;
  for (let i = 0; i < 240; i++) {
    await new Promise((r2) => setTimeout(r2, 500));
    if (!fileAt && fs.existsSync(beautyPath)) {
      const mt = fs.statSync(beautyPath).mtimeMs;
      if (mt > t0) fileAt = (Date.now() - t0) / 1000;
    }
    if (rows.some((x) => /完成/.test(x.msg || '') && x.p === 100)) break;
  }
  if (fileAt) console.log('\n产物写入完成时间：', fileAt.toFixed(1), '秒');
  console.log('\n=== 进度事件（秒 / 进度 / 文案）===');
  rows.forEach((x) => console.log(String(x.sec.toFixed(1)).padStart(6), String(x.p).padStart(4) + '%', x.msg || '(纯进度)'));
  const progRows = rows.filter((x) => typeof x.p === 'number' && x.p > 0 && x.p < 100);
  console.log('\n中间进度点数：', progRows.length);
  if (progRows.length >= 2) {
    // 用前几个点算速率，检查后面的点是否接近该速率（线性度）
    const a = progRows[0], b = progRows[progRows.length - 1];
    const rate = (b.p - a.p) / Math.max(0.1, b.sec - a.sec);
    console.log('整体速率 ≈', rate.toFixed(2), '%/秒 → 预计总耗时', (100 / rate).toFixed(1), '秒');
    console.log('实际耗时', ((Date.now() - t0) / 1000).toFixed(1), '秒');
  }

  const after = await req('GET', `/api/projects/${PID}`);
  const m = (JSON.parse(after.body).materials || []).find((x) => x.id === MID);
  console.log('beauty 记录：', m && m.beauty ? `存在，时长 ${m.beauty.duration}s，preset=${m.beauty.preset}` : '无');
  console.log('文件大小', fs.existsSync(beautyPath) ? (fs.statSync(beautyPath).size / 1e6).toFixed(1) + 'MB' : '缺失');
  sr.destroy();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
