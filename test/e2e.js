// test/e2e.js - 端到端测试：建项目→分片上传→分析→混剪→下载校验
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const MATDIR = path.join(__dirname, 'fixtures');
const OUT = '/tmp/e2e_out';
fs.mkdirSync(OUT, { recursive: true });

const CHUNK = 64 * 1024;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 会话 Cookie（账号体系上线后接口都需要登录）
let COOKIE = '';
function grabCookie(r) {
  const cs = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of cs) {
    const kv = c.split(';')[0];
    if (kv.startsWith('sid=')) COOKIE = kv;
  }
}
function withCookie(headers) { return COOKIE ? Object.assign({ Cookie: COOKIE }, headers || {}) : (headers || {}); }
async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '15954896689', password: '789215' }),
  });
  grabCookie(r);
  if (!r.ok) throw new Error('登录失败: ' + (await r.text()).slice(0, 120));
}

async function postJson(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: withCookie({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  grabCookie(r);
  return r.json();
}
async function getJson(url) { const r = await fetch(BASE + url, { headers: withCookie() }); grabCookie(r); return r.json(); }
async function fetchRaw(url) { const r = await fetch(BASE + url, { headers: withCookie() }); grabCookie(r); return r; }

async function uploadFile(projectId, file) {
  const buf = fs.readFileSync(file);
  const total = Math.max(1, Math.ceil(buf.length / CHUNK));
  const { uploadId } = await postJson(`/api/projects/${projectId}/upload/init`, {
    filename: path.basename(file), totalChunks: total, fileSize: buf.length, mime: 'video/mp4',
  });
  for (let i = 0; i < total; i++) {
    const blob = buf.subarray(i * CHUNK, Math.min(buf.length, (i + 1) * CHUNK));
    const form = new FormData();
    form.append('chunk', new Blob([blob]), 'chunk');
    form.append('uploadId', uploadId);
    form.append('index', String(i));
    const r = await fetch(BASE+`/api/projects/${projectId}/upload/chunk`, { method: 'POST', headers: withCookie(), body: form });
    if (!r.ok) throw new Error('chunk fail ' + (await r.text()));
  }
  return postJson(`/api/projects/${projectId}/upload/finish`, { uploadId });
}

(async () => {
  console.log('0) 登录主账号...');
  await login();
  console.log('   ✓ 已登录');

  console.log('1) 创建项目...');
  const proj = await postJson('/api/projects', {
    name: '栗子打包盒', category: '包装盒', ratio: '9:16',
    duration: 30, count: 3, style: '产品实拍展示',
  });
  const pid = proj.id;
  console.log('   项目ID:', pid);

  console.log('2) 分片上传素材...');
  const files = fs.readdirSync(MATDIR).map(f => path.join(MATDIR, f));
  for (const f of files) {
    const r = await uploadFile(pid, f);
    console.log(`   ✓ ${path.basename(f)} -> ${r.material.id} (${r.material.type})`);
  }

  console.log('3) 等待分析完成...');
  let mats = [];
  for (let i = 0; i < 90; i++) {
    const p = await getJson(`/api/projects/${pid}`);
    mats = p.materials;
    if (mats.every(m => m.status === 'analyzed' || m.status === 'error')) break;
    await sleep(1000);
  }
  console.log('   分析结果：');
  mats.forEach(m => {
    console.log(`   - ${m.originalName}: ${m.status} | 类别=${m.category} | 可用=${m.usable} | 问题=[${(m.problems||[]).join(',')}] | 时长=${m.duration?.toFixed?.(1)}s`);
  });

  console.log('4) 开始混剪（生成多版本）...');
  const { taskId } = await postJson(`/api/projects/${pid}/render`, {});
  console.log('   任务ID:', taskId);
  let task = null;
  for (let i = 0; i < 240; i++) {
    const p = await getJson(`/api/projects/${pid}`);
    task = p.tasks.find(t => t.id === taskId);
    if (task && (task.status === 'done' || task.status === 'error')) break;
    await sleep(1000);
  }
  console.log('   任务状态:', task && task.status, '| 提示:', (task && task.warnings || []).join(' ; '));

  const p = await getJson(`/api/projects/${pid}`);
  console.log('5) 生成视频数:', p.videos.length);
  p.videos.forEach(v => console.log(`   - ${v.version} ${v.title}: ${v.duration?.toFixed?.(1)}s ${v.width}x${v.height} ${(v.size/1024).toFixed(0)}KB`));

  console.log('6) 下载并校验视频...');
  for (const v of p.videos) {
    const r = await fetch(BASE+`/api/projects/${pid}/videos/${v.id}/file`, { headers: withCookie() });
    const ab = Buffer.from(await r.arrayBuffer());
    const outPath = path.join(OUT, `${v.version}.mp4`);
    fs.writeFileSync(outPath, ab);
    console.log(`   ✓ 下载 ${v.version} -> ${outPath} (${(ab.length/1024).toFixed(0)}KB)`);
  }

  console.log('7) FFprobe 校验首条视频...');
  const first = p.videos[0];
  if (first) {
    const outPath = path.join(OUT, `${first.version}.mp4`);
    const { spawnSync } = require('child_process');
    const ff = path.join(__dirname, '..', 'bin', 'ffprobe.exe');
    const res = spawnSync(ff, ['-v','error','-show_entries','stream=codec_type,codec_name,width,height','-of','json', outPath]);
    console.log('   ', res.stdout.toString().trim());
  }

  console.log('8) ZIP 批量下载...');
  const zr = await fetch(BASE+`/api/projects/${pid}/videos/zip`, { headers: withCookie() });
  const zab = Buffer.from(await zr.arrayBuffer());
  fs.writeFileSync(path.join(OUT, 'videos.zip'), zab);
  console.log('   ✓ ZIP 大小:', (zab.length/1024).toFixed(0), 'KB');

  console.log('9) 清理测试项目...');
  await fetch(BASE+`/api/projects/${pid}`, { method: 'DELETE', headers: withCookie() });

  console.log('\n✅ 端到端测试完成。输出目录:', OUT);
  process.exit(0);
})().catch(e => { console.error('❌ 测试失败:', e); process.exit(1); });
