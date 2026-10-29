// store.js - 项目/素材/视频的持久化（JSON + 文件系统）
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const { projectDir, materialDir, outputDir } = config;

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

async function ensureProjectDirs(id) {
  await fs.mkdir(projectDir(id), { recursive: true });
  await fs.mkdir(materialDir(id), { recursive: true });
  await fs.mkdir(path.join(materialDir(id), 'thumb'), { recursive: true });
  await fs.mkdir(outputDir(id), { recursive: true });
  await fs.mkdir(path.join(outputDir(id), 'thumb'), { recursive: true });
}

async function loadProject(id) {
  const p = path.join(projectDir(id), 'project.json');
  const raw = await fs.readFile(p, 'utf8');
  return JSON.parse(raw);
}

// 已删除项目 id 集合：防止删除后仍在跑的渲染任务把项目目录写回来
const deletedIds = new Set();

async function saveProject(project) {
  const id = id_of(project);
  if (deletedIds.has(id)) return null; // 项目已被删除，丢弃这次写入
  project.updatedAt = new Date().toISOString();
  const p = path.join(projectDir(id), 'project.json');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(project, null, 2), 'utf8');
  return project;
}

function id_of(project) { return project.id; }

// 创建项目（ownerId 为创建者账号 id）
async function createProject(meta, ownerId) {
  const id = newId('prj');
  await ensureProjectDirs(id);
  const project = {
    id,
    ownerId: ownerId || null,
    name: meta.name || '未命名项目',
    category: meta.category || '其他',
    ratio: meta.ratio || '9:16',
    duration: meta.duration || 30,
    count: meta.count || 3,
    style: meta.style || '口播介绍',
    subtitle: meta.subtitle || {
      autoTitle: true,
      autoSellPoints: true,
      autoSpeechToText: false,
      autoNarration: false,
      aiVoiceover: false,
      noNarration: true,
    },
    brand: meta.brand || { name: '', logo: '', suffix: '' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    materials: [],
    videos: [],
    tasks: [],
  };
  await saveProject(project);
  return project;
}

// 列出项目概要（按更新时间倒序）；user 为 null 时返回全部（内部使用/主账号）
async function listProjects(user) {
  try {
    const entries = await fs.readdir(config.DIRS.projects);
    const projects = [];
    for (const e of entries) {
      try {
        const proj = await loadProject(e);
        if (user && user.role !== 'owner' && proj.ownerId !== user.id) continue;
        projects.push(summary(proj));
      } catch (_) { /* 跳过损坏 */ }
    }
    projects.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return projects;
  } catch (_) {
    return [];
  }
}

// 判断项目是否属于某用户（子账号只能看自己的；主账号全看）
function ownedBy(proj, user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return proj.ownerId === user.id;
}

function summary(proj) {
  const today = todayStr();
  return {
    id: proj.id,
    ownerId: proj.ownerId || null,
    name: proj.name,
    category: proj.category,
    ratio: proj.ratio,
    duration: proj.duration,
    count: proj.count,
    style: proj.style,
    createdAt: proj.createdAt,
    updatedAt: proj.updatedAt,
    materialCount: (proj.materials || []).length,
    videoCount: (proj.videos || []).length,
    todayMaterialCount: (proj.materials || []).filter((m) => isToday(m.createdAt, today)).length,
    todayVideoCount: (proj.videos || []).filter((v) => isToday(v.createdAt, today)).length,
    status: latestTaskStatus(proj),
  };
}

// 判断某个 ISO 时间是否属于「今天」（按服务器本地时区）
function isToday(iso, todayStr) {
  if (!iso) return false;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}` === todayStr;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 首页统计：项目/今日新建项目/今日添加素材/今日生成视频/进行中任务
// user 为空 => 全站；子账号 => 仅统计自己名下项目
async function stats(user) {
  const today = todayStr();
  const out = {
    projectCount: 0,
    todayProjects: 0,
    todayMaterials: 0,
    todayVideos: 0,
    runningTasks: 0,
    videoCount: 0,
    materialCount: 0,
    today,
  };
  let entries = [];
  try { entries = await fs.readdir(config.DIRS.projects); } catch (_) { return out; }
  for (const e of entries) {
    let proj;
    try { proj = await loadProject(e); } catch (_) { continue; }
    if (user && !ownedBy(proj, user)) continue;
    out.projectCount += 1;
    out.videoCount += (proj.videos || []).length;
    out.materialCount += (proj.materials || []).length;
    if (isToday(proj.createdAt, today)) out.todayProjects += 1;
    for (const m of proj.materials || []) {
      if (isToday(m.createdAt, today)) out.todayMaterials += 1;
    }
    for (const v of proj.videos || []) {
      if (isToday(v.createdAt, today)) out.todayVideos += 1;
    }
    for (const t of proj.tasks || []) {
      if (['queued', 'planning', 'rendering'].includes(t.status)) out.runningTasks += 1;
    }
  }
  return out;
}

function latestTaskStatus(proj) {
  const tasks = proj.tasks || [];
  if (!tasks.length) return proj.videos && proj.videos.length ? 'done' : 'idle';
  return tasks[tasks.length - 1].status;
}

// 全站「今日新生成视频」聚合（按生成时间倒序）；传 user 则只看该用户名下
async function todayVideos(user) {
  const today = todayStr();
  const items = [];
  let entries = [];
  try { entries = await fs.readdir(config.DIRS.projects); } catch (_) { return { date: today, count: 0, items }; }
  for (const e of entries) {
    let proj;
    try { proj = await loadProject(e); } catch (_) { continue; }
    if (user && !ownedBy(proj, user)) continue;
    for (const v of proj.videos || []) {
      if (!isToday(v.createdAt, today)) continue;
      items.push({
        id: v.id,
        projectId: proj.id,
        ownerId: proj.ownerId || null,
        projectName: proj.name,
        category: proj.category,
        ratio: proj.ratio,
        version: v.version,
        label: v.label,
        title: v.title,
        duration: v.duration,
        size: v.size,
        width: v.width,
        height: v.height,
        locked: !!v.locked,
        createdAt: v.createdAt,
        hasThumb: !!v.thumbnail,
        path: v.path,
        fileUrl: `/api/projects/${proj.id}/videos/${v.id}/file`,
        thumbUrl: v.thumbnail ? `/api/projects/${proj.id}/videos/${v.id}/thumb` : null,
      });
    }
  }
  items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { date: today, count: items.length, items };
}

// 全站「进行中任务」聚合（排队/方案/渲染中）；传 user 则只看该用户名下
async function runningTasks(user) {
  const items = [];
  let entries = [];
  try { entries = await fs.readdir(config.DIRS.projects); } catch (_) { return { count: 0, items }; }
  for (const e of entries) {
    let proj;
    try { proj = await loadProject(e); } catch (_) { continue; }
    if (user && !ownedBy(proj, user)) continue;
    for (const t of proj.tasks || []) {
      if (!['queued', 'planning', 'rendering'].includes(t.status)) continue;
      items.push({
        taskId: t.id,
        projectId: proj.id,
        ownerId: proj.ownerId || null,
        projectName: proj.name,
        category: proj.category,
        status: t.status,
        progress: t.progress || 0,
        message: t.message || '',
        createdAt: t.createdAt,
        errors: t.errors || [],
        warnings: t.warnings || [],
        doneVersions: (t.versions || []).length,
        mode: t.opts && t.opts.single ? `单独重做：版本 ${t.opts.single}` : '整批生成',
      });
    }
  }
  items.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  return { date: todayStr(), count: items.length, items };
}

async function deleteProject(id) {
  deletedIds.add(id);
  // 先尝试整目录移到回收站（data/.trash），误删可从回收站恢复
  const trashRoot = path.join(config.DIRS.data, '.trash');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = path.join(trashRoot, `${id}_${stamp}`);
  try {
    await fs.mkdir(trashRoot, { recursive: true });
    await fs.rename(projectDir(id), trashDir);
    return;
  } catch (_) {
    // 跨盘/占用等情况下退回逐项清理
  }
  try {
    await fs.rm(projectDir(id), { recursive: true, force: true });
  } catch (_) {
    // 删除文件失败不应阻止项目记录移除（可能受环境批量删除保护）
  }
  // 尽量移除项目记录文件，确保列表不再出现
  try { await fs.unlink(path.join(projectDir(id), 'project.json')); } catch (_) {}
}

module.exports = {
  newId, ensureProjectDirs, loadProject, saveProject,
  createProject, listProjects, deleteProject, summary, stats, withLock,
  todayVideos, runningTasks, ownedBy,
};

// 按项目 ID 的互斥锁：串行化"读取-修改-保存"临界区，避免并发写互相覆盖
const locks = {};
function withLock(id, fn) {
  const prev = locks[id] || Promise.resolve();
  const next = prev.then(fn, fn);
  locks[id] = next.catch(() => {});
  return next;
}
