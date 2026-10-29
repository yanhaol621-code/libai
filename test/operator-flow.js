// test/operator-flow.js - 子账号完整剪辑流程：登录 -> 建项目 -> 上传素材 -> 分析 -> 渲染 -> 主账号可见
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
const check = (n, ok, extra) => { if (ok) { pass++; console.log('PASS  ' + n); } else { fail++; console.log('FAIL  ' + n + (extra ? '  → ' + extra : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  async function req(method, p, body, form) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + p, { method, headers, body: payload });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setC) { const kv = c.split(';')[0]; if (kv.startsWith('sid=')) cookie = kv; }
    let json = null; try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  }
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b || {}), del: (p) => req('DELETE', p), upload: (p, f) => req('POST', p, undefined, f), get cookie() { return cookie; } };
}

(async () => {
  const owner = client(), op = client();
  await owner.post('/api/auth/login', { account: '15954896689', password: '789215' });
  const suffix = Date.now().toString().slice(-5);
  const acc = 'flow' + suffix;
  const created = await owner.post('/api/team/users', { username: '剪辑测试' + suffix, account: acc, password: 'flow123456' });
  check('主账号创建运营账号', created.status === 200, JSON.stringify(created.json));
  const opId = created.json.id;

  await op.post('/api/auth/login', { account: acc, password: 'flow123456' });
  const p = await op.post('/api/projects', {
    name: '运营流程测试' + suffix, category: '包装盒', ratio: '9:16', duration: 15, count: 1, style: '产品实拍展示',
  });
  check('运营创建项目', p.status === 200 && p.json.id, JSON.stringify(p.json).slice(0, 120));
  const pid = p.json.id;

  // 分片上传一个真实测试视频
  const file = path.join(__dirname, 'fixtures', 'c1.mp4');
  const buf = fs.readFileSync(file);
  const CHUNK = 5 * 1024 * 1024;
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  const init = await op.post(`/api/projects/${pid}/upload/init`, { filename: 'c1.mp4', totalChunks: total, fileSize: buf.length, mime: 'video/mp4' });
  check('运营发起上传会话', init.status === 200 && init.json.uploadId, JSON.stringify(init.json));
  for (let i = 0; i < total; i++) {
    const form = new FormData();
    form.append('chunk', new Blob([buf.subarray(i * CHUNK, (i + 1) * CHUNK)]), 'blob');
    form.append('uploadId', init.json.uploadId);
    form.append('index', String(i));
    const r = await op.upload(`/api/projects/${pid}/upload/chunk`, form);
    if (r.status !== 200) { check('上传分片 ' + i, false, JSON.stringify(r.json)); break; }
  }
  const fin = await op.post(`/api/projects/${pid}/upload/finish`, { uploadId: init.json.uploadId });
  check('运营上传素材完成', fin.status === 200 && fin.json.material, JSON.stringify(fin.json).slice(0, 150));
  const matId = fin.json.material && fin.json.material.id;

  // 等待分析
  let analyzed = null;
  for (let i = 0; i < 60; i++) {
    const one = await op.get(`/api/projects/${pid}`);
    const m = (one.json.materials || []).find((x) => x.id === matId);
    if (m && (m.status === 'analyzed' || m.status === 'error')) { analyzed = m; break; }
    await sleep(1000);
  }
  check('素材分析完成', !!analyzed && analyzed.status === 'analyzed', analyzed && JSON.stringify({ s: analyzed.status, c: analyzed.category, d: analyzed.duration }));
  check('分析出真实时长', analyzed && analyzed.duration > 1, analyzed && String(analyzed.duration));

  // 渲染
  const r = await op.post(`/api/projects/${pid}/render`, {});
  check('运营发起渲染任务', r.status === 200 && r.json.taskId, JSON.stringify(r.json));
  const taskId = r.json.taskId;

  let task = null;
  for (let i = 0; i < 150; i++) {
    const one = await op.get(`/api/projects/${pid}`);
    task = (one.json.tasks || []).find((t) => t.id === taskId);
    if (task && (task.status === 'done' || task.status === 'error')) break;
    await sleep(1000);
  }
  check('渲染任务完成', task && task.status === 'done', task && (task.status + ': ' + String(task.message).slice(0, 160)));

  const after = await op.get(`/api/projects/${pid}`);
  const videos = after.json.videos || [];
  check('产出视频文件记录', videos.length >= 1, 'count=' + videos.length);
  if (videos[0]) {
    check('视频为 1080x1920 MP4', videos[0].width === 1080 && videos[0].height === 1920, `${videos[0].width}x${videos[0].height}`);
    const head = await fetch(`${BASE}/api/projects/${pid}/videos/${videos[0].id}/file`, { headers: { Cookie: op.cookie } });
    check('运营可播放/下载自己的成品', head.status === 200, 'code=' + head.status);
  }

  // 主账号视角可见运营产出
  const ov = await owner.get('/api/team/overview');
  const row = (ov.json.rows || []).find((x) => x.user.id === opId);
  check('主账号团队页看到该运营今日 1 个项目', row && row.stats.todayProjects === 1, row && JSON.stringify(row.stats));
  check('主账号团队页看到今日 1 条视频', row && row.todayVideoCount === 1, row && String(row.todayVideoCount));
  const opVideos = await owner.get('/api/today/videos?user=' + opId);
  check('主账号可按运营筛出今日视频', opVideos.json.count === 1 && opVideos.json.items[0].ownerName, JSON.stringify(opVideos.json).slice(0, 160));

  // 运营看不到主账号项目（反向隔离）
  const mainProjects = (await owner.get('/api/projects')).json.filter((x) => x.ownerId === 'usr_owner');
  if (mainProjects[0]) {
    const blocked = await op.get('/api/projects/' + mainProjects[0].id);
    check('运营访问主账号项目被拒 403', blocked.status === 403, 'code=' + blocked.status);
  }

  // 清理
  await op.del('/api/projects/' + pid);
  const delUser = await owner.del('/api/team/users/' + opId);
  check('清理测试数据', delUser.status === 200);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
