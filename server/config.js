// config.js - 全局配置与路径解析
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

// 查找 FFmpeg / ffprobe 可执行文件
function resolveBin(envVal, names) {
  if (envVal && fs.existsSync(path.resolve(ROOT, envVal))) {
    return path.resolve(ROOT, envVal);
  }
  // 候选路径
  const candidates = [
    path.join(ROOT, 'bin', 'ffmpeg.exe'),
    path.join(ROOT, 'bin', 'ffmpeg'),
    path.join(ROOT, 'bin', 'ffprobe.exe'),
    path.join(ROOT, 'bin', 'ffprobe'),
    '/c/Windows/SysWOW64/JHlib/ffmpeg/ffmpeg.exe',
    '/c/Windows/SysWOW64/JHlib/ffmpeg/ffprobe.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return names[0]; // 回退，交给系统 PATH
}

const FFMPEG_PATH = process.env.FFMPEG_PATH
  ? (fs.existsSync(path.resolve(ROOT, process.env.FFMPEG_PATH))
      ? path.resolve(ROOT, process.env.FFMPEG_PATH)
      : process.env.FFMPEG_PATH)
  : (fs.existsSync(path.join(ROOT, 'bin', 'ffmpeg.exe'))
      ? path.join(ROOT, 'bin', 'ffmpeg.exe')
      : 'ffmpeg');

const FFPROBE_PATH = process.env.FFPROBE_PATH
  ? (fs.existsSync(path.resolve(ROOT, process.env.FFPROBE_PATH))
      ? path.resolve(ROOT, process.env.FFPROBE_PATH)
      : process.env.FFPROBE_PATH)
  : (fs.existsSync(path.join(ROOT, 'bin', 'ffprobe.exe'))
      ? path.join(ROOT, 'bin', 'ffprobe.exe')
      : 'ffprobe');

const PORT = parseInt(process.env.PORT || '3000', 10);
const GENERATE_DEMO_MUSIC = (process.env.GENERATE_DEMO_MUSIC || 'true') !== 'false';

// 目录结构
const DIRS = {
  root: ROOT,
  data: DATA_DIR,
  projects: path.join(DATA_DIR, 'projects'),
  materials: path.join(DATA_DIR, 'materials'), // 全局素材缓存（可选）
  outputs: path.join(DATA_DIR, 'outputs'),
  temp: path.join(DATA_DIR, 'temp'),
  music: path.join(DATA_DIR, 'music'),
  avatars: path.join(DATA_DIR, 'avatars'),
  chat: path.join(DATA_DIR, 'chat'),
  chatFiles: path.join(DATA_DIR, 'chat', 'files'),
};

function projectDir(id) {
  return path.join(DIRS.projects, id);
}
function materialDir(id) {
  return path.join(projectDir(id), 'materials');
}
function outputDir(id) {
  return path.join(projectDir(id), 'outputs');
}

module.exports = {
  ROOT, DATA_DIR, DIRS, FFMPEG_PATH, FFPROBE_PATH, PORT, GENERATE_DEMO_MUSIC,
  projectDir, materialDir, outputDir,
  ensureDirs() {
    for (const k of ['data', 'projects', 'outputs', 'temp', 'music', 'avatars', 'chat', 'chatFiles']) {
      fs.mkdirSync(DIRS[k], { recursive: true });
    }
  },
};
