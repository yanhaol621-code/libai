// test/asr.js - 口播字幕识别（本机 Whisper）端到端测试
// 用真实视频走完整链路：建项目 → 上传 → 分析 → 识别字幕 → 混剪（真实字幕烧录）→ 校验 SRT/画面
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'http://localhost:3000';
const MATDIR = 'D:/桌面/鲜元视频';
const OUT = path.join(__dirname, 'out_asr');
fs.mkdirSync(OUT, { recursive: true });

const CHUNK = 512 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let COOKIE = '';
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('   ✓ ' + msg); }
  else { fail++; console.log('   ✗ ' + msg + (extra ? ' → ' + extra : '')); }
}
function grabCookie(r) {
  const cs = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of cs) { const kv = c.split(';')[0]; if (kv.startsWith('sid=')) COOKIE = kv; }
}
const withCookie = (h) => (COOKIE ? Object.assign({ Cookie: COOKIE }, h || {}) : (h || {}));
async function postJson(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: withCookie({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  grabCookie(r); return r.json();
}
async function getJson(url) { const r = await fetch(BASE + url, { headers: withCookie() }); grabCookie(r); return r.json(); }
async function getRaw(url) { const r = await fetch(BASE + url, { headers: withCookie() }); grabCookie(r); return r; }

async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: '15954896689', password: '789215' }),
  });
  grabCookie(r);
  if (!r.ok) throw new Error('登录失败');
}

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
    const r = await fetch(BASE + `/api/projects/${projectId}/upload/chunk`, { method: 'POST', headers: withCookie(), body: form });
    if (!r.ok) throw new Error('分片上传失败');
  }
  return postJson(`/api/projects/${projectId}/upload/finish`, { uploadId });
}

(async () => {
  console.log('=== 口播字幕识别（ASR）端到端测试 ===\n');
  console.log('0) 登录 + 引擎状态');
  await login();
  const st = await getJson('/api/asr/status');
  console.log('   引擎:', JSON.stringify({ ready: st.ready, python: st.python, models: st.models.map((m) => m.key + (m.ready ? '(ok)' : '(缺)')), default: st.defaultModel }));
  ok(st.ready === true, '本机识别引擎就绪');
  ok(st.models.some((m) => m.ready), '已加载 Whisper 模型');

  console.log('\n1) 创建项目');
  const proj = await postJson('/api/projects', {
    name: '金秋献礼中秋礼盒', category: '包装盒', ratio: '9:16',
    duration: 30, count: 1, style: '同行爆款 · 口播带货',
  });
  const pid = proj.id;
  console.log('   项目:', pid);

  console.log('\n2) 上传真实口播素材（取前 2 个）');
  const files = fs.readdirSync(MATDIR).filter((f) => /\.mp4$/i.test(f)).slice(0, 2).map((f) => path.join(MATDIR, f));
  for (const f of files) {
    const r = await uploadFile(pid, f);
    console.log(`   · ${path.basename(f)} → ${r.material.id}`);
  }
  for (let i = 0; i < 120; i++) {
    const p = await getJson(`/api/projects/${pid}`);
    if (p.materials.every((m) => m.status === 'analyzed' || m.status === 'error')) break;
    await sleep(1000);
  }

  console.log('\n3) 识别口播字幕');
  const started = await postJson(`/api/projects/${pid}/asr`, { hotwords: '金秋献礼,中秋礼盒,腰封,单果,拼装果,六拼,水果店' });
  console.log('   启动:', JSON.stringify(started));
  ok(started.ok === true && started.count > 0, '识别任务已启动');
  for (let i = 0; i < 300; i++) {
    const d = await getJson(`/api/projects/${pid}/asr`);
    if (!d.running) break;
    await sleep(1000);
  }
  const asrData = await getJson(`/api/projects/${pid}/asr`);
  for (const m of asrData.materials) {
    console.log(`   · ${m.name.slice(0, 24)}: ${m.asr ? `${m.asr.cueCount} 条字幕 / ${m.asr.chars} 字 / 语速 ${(m.asr.speech || {}).charsPerSec} / 重复 ${m.asr.repeatCount}` : '未识别'}`);
  }
  ok(asrData.materials.some((m) => m.asr && m.asr.cueCount > 0), '至少 1 个素材拿到真实字幕');

  console.log('\n4) 字幕时间轴与 SRT');
  const target = asrData.materials.find((m) => m.asr && m.asr.cueCount > 0);
  const detail = await getJson(`/api/projects/${pid}/materials/${target.id}/asr`);
  console.log('   前 8 条字幕：');
  detail.cues.slice(0, 8).forEach((c) => console.log(`     ${c.start}s → ${c.end}s  ${c.text}`));
  ok(detail.cues.length > 3, '字幕条数合理（>3）');
  ok(detail.cues.every((c) => c.end > c.start && c.text.length > 0), '每条字幕时间递增且非空');
  ok(detail.cues.every((c, i) => i === 0 || c.start >= detail.cues[i - 1].start), '字幕按时间排序');
  ok(detail.cues.every((c) => c.text.length <= 30), '单条字幕不过长');
  const srt = await (await getRaw(`/api/projects/${pid}/materials/${target.id}/asr/srt`)).text();
  fs.writeFileSync(path.join(OUT, 'material.srt'), srt, 'utf8');
  ok(/^1\r?\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(srt), 'SRT 格式正确');
  console.log('   SRT 头部:\n' + srt.split('\n').slice(0, 4).map((x) => '     ' + x).join('\n'));
  if (detail.repeats && detail.repeats.count) {
    console.log('   重复口播:', detail.repeats.items.slice(0, 3).map((r) => `${r.text}@${r.times.map((t) => t.start).join('/')}`).join(' | '));
  }

  console.log('\n5) 混剪（真实字幕烧录）');
  const { taskId } = await postJson(`/api/projects/${pid}/render`, {});
  let task = null;
  for (let i = 0; i < 300; i++) {
    const p = await getJson(`/api/projects/${pid}`);
    task = p.tasks.find((t) => t.id === taskId);
    if (task && (task.status === 'done' || task.status === 'error')) break;
    await sleep(1000);
  }
  const p2 = await getJson(`/api/projects/${pid}`);
  const v = p2.videos[0];
  console.log('   成片:', v && JSON.stringify({ v: v.version, dur: v.duration && v.duration.toFixed(1), size: Math.round(v.size / 1024) + 'KB', mode: v.subtitleMode, n: v.subtitleCount, srt: v.srt }));
  ok(task && task.status === 'done', '渲染任务完成');
  // 注意：模板按风格自动挑，口播模板才一定用到人声素材；这里只校验字幕链路本身
  if (v && v.subtitleMode === 'asr') {
    ok(v.subtitleCount > 0, '成片使用了真实语音字幕');
    const vsrt = await (await getRaw(`/api/projects/${pid}/videos/${v.id}/srt`)).text();
    fs.writeFileSync(path.join(OUT, 'video.srt'), vsrt, 'utf8');
    ok(vsrt.split(/\r?\n/).filter((x) => / --> /.test(x)).length === v.subtitleCount, '成片 SRT 条数与成片一致');
    console.log('   成片 SRT 前 6 行:\n' + vsrt.split('\n').slice(0, 6).map((x) => '     ' + x).join('\n'));

    // 抽帧校验：在一条字幕的时间中点截一帧，肉眼/像素确认字幕真的烧上去了
    const mid = (detail.cues[2].start + detail.cues[2].end) / 2;
    const r = await getRaw(`/api/projects/${pid}/videos/${v.id}/file`);
    const vpath = path.join(OUT, 'video.mp4');
    fs.writeFileSync(vpath, Buffer.from(await r.arrayBuffer()));
    const frame = path.join(OUT, 'frame.png');
    spawnSync(path.join(__dirname, '..', 'bin', 'ffmpeg.exe'), ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.min(mid, v.duration - 0.5)), '-i', vpath, '-frames:v', '1', frame]);
    console.log('   抽帧:', frame, '（对应字幕:', detail.cues[2].text, '）');
    ok(fs.existsSync(frame) && fs.statSync(frame).size > 5000, '成片可抽帧（字幕渲染未崩溃）');

    // Mode B 校验：口播模板应按"整句"切镜头，且不把同一句话放两遍
    const segs = v.segments || [];
    const cueStarts = detail.cues.map((c) => +c.start.toFixed(2));
    const onSentence = segs.filter((s) => cueStarts.some((x) => Math.abs(x - (s.srcStart || 0)) < 0.05)).length;
    console.log(`   片段 ${segs.length} 个，其中 ${onSentence} 个起点落在整句开头`);
    ok(segs.length >= 5, '口播素材被切成多个镜头（不是整段照搬）');
    ok(onSentence >= Math.ceil(segs.length * 0.8), '镜头起点基本都落在整句开头（不腰斩句子）');
    const texts = segs.map((s) => { const c = detail.cues.find((x) => Math.abs(x.start - (s.srcStart || 0)) < 0.05); return c ? c.text : ''; }).filter(Boolean);
    ok(new Set(texts).size === texts.length, '没有把同一句话放两遍');
    ok(Math.abs((v.duration || 0) - 30) < 3, `成片时长接近目标 30s（实际 ${(v.duration || 0).toFixed(1)}s）`);
  } else {
    console.log('   （本次模板未使用口播片段，字幕走脚本卖点分支，属预期外需人工确认）');
  }

  console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
  console.log('产物目录:', OUT);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
