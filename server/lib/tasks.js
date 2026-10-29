// tasks.js - 异步渲染任务队列 + 进度事件（SSE）
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs/promises');
const config = require('../config');
const store = require('./store');
const editor = require('./editor');
const render = require('./render');

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const queue = [];
let running = false;

function emit(taskId, data) {
  emitter.emit('task:' + taskId, data);
  emitter.emit('project:' + data.projectId, data);
}

function subscribe(eventName, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const listener = (data) => send(data);
  emitter.on(eventName, listener);
  req.on('close', () => emitter.removeListener(eventName, listener));
  return send;
}

async function enqueue(projectId, opts = {}) {
  const id = store.newId('task');
  const task = {
    id, projectId, type: 'render', status: 'queued', progress: 0,
    message: '等待中', createdAt: new Date().toISOString(),
    versions: [], warnings: [], errors: [], opts,
  };
  const project = await store.loadProject(projectId);
  project.tasks.push(task);
  await store.saveProject(project);
  queue.push({ taskId: id, projectId, opts });
  pump();
  return task;
}

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  try {
    await processJob(job);
  } catch (e) {
    await failTask(job.projectId, job.taskId, e.message);
  } finally {
    running = false;
    pump();
  }
}

async function failTask(projectId, taskId, message) {
  const project = await store.loadProject(projectId).catch(() => null);
  if (!project) return;
  const task = project.tasks.find((t) => t.id === taskId);
  if (task) {
    task.status = 'error';
    task.message = message;
    task.errors.push(message);
  }
  await store.saveProject(project);
  emit(taskId, { taskId, projectId, status: 'error', message, progress: 100 });
}

async function processJob(job) {
  const { projectId, taskId, opts } = job;
  const project = await store.loadProject(projectId);
  const task = project.tasks.find((t) => t.id === taskId);
  if (!task) return;

  task.status = 'planning';
  task.message = '生成多版本剪辑方案';
  task.progress = 5;
  emit(taskId, { taskId, projectId, status: 'planning', progress: 5, message: task.message });

  const plan = editor.buildPlans(project);
  task.warnings = plan.warnings;
  if (opts.single) {
    const v = plan.versions.find((x) => x.version === opts.single);
    if (!v) throw new Error('未找到指定版本');
    // 应用覆盖（来自视频编辑页）
    if (opts.overrides) applyOverrides(v, opts.overrides);
    await renderOne(project, task, v, taskId, emit, opts);
  } else {
    const n = plan.versions.length;
    for (let i = 0; i < n; i++) {
      const v = plan.versions[i];
      if (!v.segments || v.segments.length === 0) {
        task.warnings.push(`版本 ${v.version} 没有可用镜头，已跳过。`);
        emit(taskId, { taskId, projectId, status: 'rendering', progress: 10 + Math.round((i + 1) / n * 85), message: `版本 ${v.version} 无可用镜头，跳过` });
        continue;
      }
      await renderOne(project, task, v, taskId, emit, opts, i + 1, n);
    }
  }

  // 最终保存任务状态（加锁重载，避免覆盖已写入的视频）
  await store.withLock(projectId, async () => {
    const proj = await store.loadProject(projectId);
    const t = proj.tasks.find((x) => x.id === taskId);
    if (t) { t.status = 'done'; t.message = '全部生成完成'; t.progress = 100; }
    await store.saveProject(proj);
  });
  emit(taskId, { taskId, projectId, status: 'done', progress: 100, message: '全部生成完成', warnings: task.warnings });
}

function applyOverrides(version, overrides) {
  if (overrides.title !== undefined) version.title = overrides.title;
  if (overrides.segments) version.segments = overrides.segments;
  // 开场钩子与片尾卡文案（编辑页可改）
  if (overrides.hook !== undefined) version.hook = overrides.hook;
  if (overrides.ending && typeof overrides.ending === 'object') {
    version.ending = Object.assign({}, version.ending, {
      main: overrides.ending.main !== undefined ? overrides.ending.main : (version.ending || {}).main,
      sub: overrides.ending.sub !== undefined ? overrides.ending.sub : (version.ending || {}).sub,
    });
  }
  // 音乐模式：project(项目已上传) / demo(系统示例) / none(静音)
  if (overrides.music) version.musicMode = overrides.music;
}

async function renderOne(project, task, version, taskId, emit, opts, index, total) {
  const outName = `${taskId}_v${version.version}.mp4`;
  const outPath = path.join(config.outputDir(project.id), outName);
  // 应用版本级配乐覆盖
  const projForRender = Object.assign({}, project);
  if (version.musicMode === 'none') { projForRender.musicPath = ''; projForRender.musicLibId = ''; }
  else if (version.musicMode === 'project') projForRender.musicPath = project.musicPath || '';
  else if (version.musicPath) { projForRender.musicPath = version.musicPath; projForRender.musicLibId = ''; }

  const baseProgress = index ? 10 + (index - 1) / total * 85 : 10;
  const span = total ? 85 / total : 85;

  emit(taskId, { taskId, projectId: project.id, status: 'rendering', progress: Math.round(baseProgress), message: `渲染版本 ${version.version}（${version.label}）`, version: version.version });
  const result = await render.renderVersion(projForRender, version, outPath, (p, msg) => {
    emit(taskId, {
      taskId, projectId: project.id, status: 'rendering',
      progress: Math.round(baseProgress + (p / 100) * span),
      message: `${version.version} ${msg}`, version: version.version,
    });
  });

  // 写入/更新视频记录（加锁，避免与素材分析并发覆盖）
  const video = {
    id: store.newId('vid'),
    taskId, version: version.version, label: version.label,
    title: version.title, hook: version.hook, ending: version.ending,
    template: (version.template || {}).name || '',
    path: outName, thumbnail: result.thumbnail,
    duration: result.duration, size: result.size, width: result.width, height: result.height,
    locked: false, createdAt: new Date().toISOString(), segments: version.segments,
    // 字幕信息：asr=真实语音识别字幕（附 SRT），script=脚本卖点字幕
    srt: result.srt || '', subtitleMode: result.subtitleMode || 'script', subtitleCount: result.subtitleCount || 0,
  };
  await store.withLock(project.id, async () => {
    const proj = await store.loadProject(project.id);
    let existingIdx = -1;
    // 编辑页"重新生成"：按 videoId 精确替换原视频
    if (opts && opts.videoId) existingIdx = proj.videos.findIndex((v) => v.id === opts.videoId);
    // 兜底：同任务同版本
    if (existingIdx < 0) existingIdx = proj.videos.findIndex((v) => v.taskId === taskId && v.version === version.version);
    if (existingIdx >= 0) {
      const old = proj.videos[existingIdx];
      video.id = old.id;          // 保留原 id，前端链接不失效
      video.locked = old.locked;  // 保留锁定状态
      proj.videos[existingIdx] = Object.assign(old, video);
    } else {
      proj.videos.push(video);
    }
    task = proj.tasks.find((t) => t.id === taskId);
    task.versions.push({ version: version.version, label: version.label, status: 'ok' });
    await store.saveProject(proj);
  });
  emit(taskId, { taskId, projectId: project.id, status: 'rendering', progress: Math.round(baseProgress + span), message: `版本 ${version.version} 完成`, version: version.version, video });
}

// 删除视频记录（保留文件或连同文件）
async function deleteVideo(projectId, videoId) {
  const project = await store.loadProject(projectId);
  const idx = project.videos.findIndex((v) => v.id === videoId);
  if (idx < 0) throw new Error('视频不存在');
  const v = project.videos[idx];
  try { await fs.unlink(path.join(config.outputDir(projectId), v.path)); } catch (_) {}
  project.videos.splice(idx, 1);
  await store.saveProject(project);
  return true;
}

function emitProject(projectId, data) {
  emitter.emit('project:' + projectId, Object.assign({ projectId }, data));
}

module.exports = { enqueue, subscribe, deleteVideo, emitProject, emitter };
