// musiclib.js - 背景音乐素材库（跨项目留存）
// 所有曲目存在 data/music-library/ 下，index.json 记录元信息；
// 首次访问自动播种一组「产品口播讲解类」原创合成 BGM（music.js 合成，无第三方版权）。
// 用户也可上传自有版权音乐入库；抖音等平台热音频属于平台/唱片公司版权音乐，
// 站外商用有侵权下架风险，程序化导出也违反平台条款，因此不做抓取，只提供合规来源。

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');
const music = require('./music');
const store = require('./store');

const DIR = path.join(config.DIRS.data, 'music-library');
const INDEX = path.join(DIR, 'index.json');

// 内置种子：按「产品口播讲解类短视频 BGM」需求筛选（轻快商务 / 干净 / 中速 / 纯音乐 / 可循环）
const SEEDS = [
  { key: 'piano',   name: '轻钢琴 · 晨光叙述',     style: '轻快商务 · 轻钢琴',     scene: '产品介绍、功能讲解口播，旋律干净不抢人声' },
  { key: 'ambient', name: '氛围合成器 · 演示空间', style: '氛围合成器 · 长铺底',   scene: '软件工具、功能演示、界面走查，透气干净' },
  { key: 'guitar',  name: '轻柔吉他 · 好物时光',   style: '轻柔吉他 · 拨弦',       scene: '好物分享、开箱测评、生活化讲解，温暖中性' },
  { key: 'groove',  name: '轻打击乐 · 平稳律动',   style: '轻打击乐 · 中速律动',   scene: '卖点罗列、节奏型产品展示，平稳不激昂' },
  { key: 'speech',  name: '轻柔底乐 · 纯口播',     style: '极简氛围 · 超低存在感', scene: '长段落纯口播，BGM 存在感压到最低' },
  { key: 'luxe',    name: '舒缓轻奢 · 质感铺底',   style: '轻奢氛围 · 慢速',       scene: '礼盒/精品类产品展示、收尾段落' },
];

let cache = null;

async function ensureDir() { await fs.mkdir(DIR, { recursive: true }); }

async function loadIndex() {
  if (cache) return cache;
  try { cache = JSON.parse(await fs.readFile(INDEX, 'utf8')); } catch (_) { cache = null; }
  if (!cache || !Array.isArray(cache.tracks)) cache = { seeded: false, tracks: [] };
  if (!cache.seeded) {
    try { await seed(); } catch (e) { console.warn('[musiclib] 播种失败:', e.message); }
  }
  return cache;
}

async function saveIndex() {
  await ensureDir();
  await fs.writeFile(INDEX, JSON.stringify(cache, null, 2), 'utf8');
}

// 首次播种：从系统原创配乐缓存复制入库，逐条探测真实时长
async function seed() {
  for (const s of SEEDS) {
    try {
      const preset = music.PRESETS[s.key];
      if (!preset) continue;
      const src = await music.ensureTrack(s.key);
      const id = store.newId('ml');
      const dest = path.join(DIR, id + (path.extname(src.path) || '.m4a'));
      await ensureDir();
      await fs.copyFile(src.path, dest);
      let duration = 0;
      try { duration = (await ffmpeg.probe(dest)).duration || 0; } catch (_) {}
      cache.tracks.push({
        id, name: s.name, style: s.style, scene: s.scene,
        source: '生成', bpm: preset.bpm, duration: Math.round(duration * 10) / 10,
        file: dest, createdAt: new Date().toISOString(),
      });
    } catch (e) {
      console.warn('[musiclib] 播种失败（跳过）:', s.key, e.message);
    }
  }
  cache.seeded = true;
  await saveIndex();
}

async function list() {
  const idx = await loadIndex();
  return [...idx.tracks].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function get(id) {
  const idx = await loadIndex();
  return idx.tracks.find((t) => t.id === id) || null;
}

// 上传自有音乐入库（memoryStorage 的 buffer）
async function addBuffer(buffer, originalName, meta) {
  const idx = await loadIndex();
  const safe = String(originalName || 'music.mp3').replace(/[\\/:*?"<>|]/g, '_');
  const ext = (path.extname(safe) || '.mp3').toLowerCase();
  const id = store.newId('ml');
  await ensureDir();
  const dest = path.join(DIR, id + ext);
  await fs.writeFile(dest, buffer);
  let duration = 0;
  try { duration = (await ffmpeg.probe(dest)).duration || 0; } catch (_) {}
  const track = {
    id,
    name: (meta && meta.name) ? String(meta.name).slice(0, 60) : safe.replace(ext, ''),
    style: (meta && meta.style) ? String(meta.style).slice(0, 40) : '自有音乐',
    scene: (meta && meta.scene) ? String(meta.scene).slice(0, 120) : '用户上传（自行确认商用版权）',
    source: '上传',
    bpm: null,
    duration: Math.round(duration * 10) / 10,
    file: dest,
    createdAt: new Date().toISOString(),
  };
  idx.tracks.push(track);
  await saveIndex();
  return track;
}

// 按系统预设生成一首入库（AI 生成按钮）
async function addGenerated(key) {
  const preset = music.PRESETS[key];
  if (!preset) throw new Error('未知的音乐风格');
  const src = await music.ensureTrack(key); // 有缓存直接复用，只合成一次
  const idx = await loadIndex();
  const id = store.newId('ml');
  await ensureDir();
  const dest = path.join(DIR, id + path.extname(src.path));
  await fs.copyFile(src.path, dest);
  let duration = 0;
  try { duration = (await ffmpeg.probe(dest)).duration || 0; } catch (_) {}
  const track = {
    id,
    name: preset.label,
    style: 'AI 原创 · ' + Math.round(preset.bpm) + 'BPM',
    scene: '系统合成原创配乐，可商用、无第三方版权',
    source: '生成',
    bpm: preset.bpm,
    duration: Math.round(duration * 10) / 10,
    file: dest,
    createdAt: new Date().toISOString(),
  };
  idx.tracks.push(track);
  await saveIndex();
  return track;
}

// 同时被 project.musicLibId 引用的曲目删除时，引用方会在渲染时自动回退默认配乐
async function remove(id) {
  const idx = await loadIndex();
  const i = idx.tracks.findIndex((t) => t.id === id);
  if (i < 0) throw new Error('曲目不存在');
  const [t] = idx.tracks.splice(i, 1);
  await saveIndex();
  if (t.file && fsSync.existsSync(t.file) && t.file.startsWith(DIR)) {
    await fs.unlink(t.file).catch(() => {});
  }
  return t;
}

module.exports = { list, get, addBuffer, addGenerated, remove, DIR };
