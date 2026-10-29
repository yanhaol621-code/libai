// ffmpeg.js - FFmpeg / ffprobe 封装与常用操作
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

function quote(p) { return `"${p}"`; }

// 并发限制器：避免同时启动过多 ffmpeg 进程导致机器过载/卡死
const MAX_CONCURRENT = 4;
let active = 0;
const waiters = [];
function acquire() {
  return new Promise((res) => {
    if (active < MAX_CONCURRENT) { active++; res(); }
    else waiters.push(res);
  });
}
function release() {
  active--;
  if (waiters.length) { active++; waiters.shift()(); }
}

// 通用执行：返回 { code, stdout, stderr }
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    acquire().then(() => {
      const ps = spawn(bin, args, { windowsHide: true, cwd: config.ROOT });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    // opts.killOn：在输出里看到某个标记就立刻收掉进程（当成功处理）
    // 用途：beauty_face.py 打完 "DONE frames=N" 时成品已经落盘，但 MediaPipe 退出前会去上报遥测，
    // 国内网络下要卡 40 秒左右，白等。看到 DONE 直接 kill，结果完全一样。
    let killedBy = false;
    const checkKill = (txt) => {
      if (killedBy || !opts.killOn) return;
      opts.killOn.lastIndex = 0;
      if (opts.killOn.test(txt)) {
        killedBy = true;
        try { ps.kill('SIGKILL'); } catch (_) {}
      }
    };
    if (opts.timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        try { ps.kill('SIGKILL'); } catch (_) {}
      }, opts.timeout);
    }
    ps.stdout.on('data', (d) => {
      stdout += d.toString();
      if (opts.onProgress) opts.onProgress(d.toString());
      checkKill(d.toString());
    });
    ps.stderr.on('data', (d) => {
      stderr += d.toString();
      if (opts.onProgress) opts.onProgress(d.toString());
      checkKill(d.toString());
    });
    ps.on('error', (err) => {
      if (timer) clearTimeout(timer);
      release();
      reject(err);
    });
    ps.on('close', (code) => {
      if (timer) clearTimeout(timer);
      release();
      // 解析进度
      const progress = opts.onProgress ? parseProgress(stderr) : null;
      if (killedBy) {
        resolve({ code: 0, stdout, stderr, stoppedEarly: true, progress });
      } else if (timedOut) {
        resolve({ code: -1, stdout, stderr, timedOut: true, progress });
      } else {
        resolve({ code, stdout, stderr, progress });
      }
    });
    });
  });
}

// 从 ffmpeg stderr 解析当前时间进度（time=HH:MM:SS.xx 或 time=xx.xx）
function parseProgress(stderr) {
  const m = stderr.match(/time=(\d+:\d+:\d+\.\d+|\d+\.\d+)/g);
  if (!m) return null;
  const last = m[m.length - 1].replace('time=', '');
  const parts = last.split(':');
  let sec = 0;
  if (parts.length === 3) {
    sec = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
  } else {
    sec = parseFloat(last);
  }
  return sec;
}

// ffprobe 获取元数据
async function probe(file) {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    path.resolve(file),
  ];
  const { code, stdout, stderr } = await run(config.FFPROBE_PATH, args, { timeout: 60000 });
  if (code !== 0) throw new Error('ffprobe 失败: ' + stderr.slice(0, 300));
  let data;
  try { data = JSON.parse(stdout); } catch (e) { throw new Error('ffprobe 解析失败'); }
  const videoStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const audioStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = data.format || {};
  // 手机竖拍常见「编码 1920x1080 + rotate=90」，ffmpeg 解码/浏览器播放都会自动旋正，
  // 对外统一报旋正后的宽高（否则素材信息会显示成横向分辨率、按宽高算比例的地方也会错）
  const rot = Number(videoStream && videoStream.tags && videoStream.tags.rotate) || 0;
  const swap = Math.abs(rot) % 180 === 90;
  return {
    format: fmt.format_name,
    duration: parseFloat(fmt.duration || (videoStream && videoStream.duration) || 0),
    size: parseInt(fmt.size || 0, 10),
    bitrate: parseInt(fmt.bit_rate || 0, 10),
    video: videoStream ? {
      codec: videoStream.codec_name,
      width: swap ? videoStream.height : videoStream.width,
      height: swap ? videoStream.width : videoStream.height,
      codedWidth: videoStream.width,
      codedHeight: videoStream.height,
      rFrameRate: videoStream.r_frame_rate,
      rotation: rot || undefined,
      nbFrames: videoStream.nb_frames,
    } : null,
    audio: audioStream ? { codec: audioStream.codec_name, sampleRate: audioStream.sample_rate } : null,
    raw: data,
  };
}

// 生成缩略图（取指定时间点）
async function thumbnail(file, out, timeSec = 1, w = 480, h = -1) {
  const args = [
    '-y', '-ss', String(timeSec), '-i', path.resolve(file),
    '-frames:v', '1', '-vf', `scale='min(${w},iw)':-1`,
    '-q:v', '4', path.resolve(out),
  ];
  const { code, stderr } = await run(config.FFMPEG_PATH, args, { timeout: 60000 });
  if (code !== 0) throw new Error('缩略图生成失败: ' + stderr.slice(0, 200));
  return out;
}

// 黑屏检测
async function detectBlack(file, opts = {}) {
  const blackMin = opts.blackMinDuration || 0.3;
  const pictureBlackRatio = opts.pictureBlackRatio || 0.98;
  const args = [
    '-i', path.resolve(file),
    '-vf', `blackdetect=d=${blackMin}:pic_th=${pictureBlackRatio}`,
    '-an', '-f', 'null', '-',
  ];
  const { stderr } = await run(config.FFMPEG_PATH, args, { timeout: 120000 });
  const results = [];
  const re = /blackdetect.*?black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    results.push({ start: +m[1], end: +m[2], duration: +m[3] });
  }
  return results;
}

// 静音检测
async function detectSilence(file, opts = {}) {
  const noise = opts.noise || -35; // dB
  const duration = opts.duration || 0.5;
  const args = [
    '-i', path.resolve(file),
    '-af', `silencedetect=n=${noise}dB:d=${duration}`,
    '-f', 'null', '-',
  ];
  const { stderr } = await run(config.FFMPEG_PATH, args, { timeout: 120000 });
  const silences = [];
  const reStart = /silence_start: ([\d.]+)/g;
  const reEnd = /silence_end: ([\d.]+)/g;
  const starts = []; let m;
  while ((m = reStart.exec(stderr))) starts.push(+m[1]);
  const ends = []; while ((m = reEnd.exec(stderr))) ends.push(+m[1]);
  for (let i = 0; i < starts.length; i++) {
    silences.push({ start: starts[i], end: ends[i] !== undefined ? ends[i] : null, duration: ends[i] !== undefined ? ends[i] - starts[i] : null });
  }
  return silences;
}

// 运动/静止评分：抽取两个间隔帧，计算差异（blend difference -> signalstats YAVG）
async function motionScore(file, dur) {
  try {
    const t1 = Math.min(0.5, dur * 0.2);
    const t2 = Math.min(dur * 0.6, dur - 0.2);
    if (t2 <= t1) return { score: 0, note: '时长过短' };
    const args = [
      '-ss', String(t1), '-i', path.resolve(file),
      '-ss', String(t2), '-i', path.resolve(file),
      '-filter_complex', '[0][1]blend=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG',
      '-frames:v', '1', '-f', 'null', '-',
    ];
    const { stderr } = await run(config.FFMPEG_PATH, args, { timeout: 40000 });
    const m = stderr.match(/YAVG=([\d.]+)/g);
    if (!m) return { score: 0, note: '无信号' };
    const vals = m.map((x) => parseFloat(x.replace('YAVG=', '')));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { score: +avg.toFixed(2) };
  } catch (e) {
    return { score: 0, note: '检测失败' };
  }
}

// 清晰度（边缘强度）代理：gradients 滤镜 + signalstats YAVG
async function sharpnessScore(file, dur) {
  try {
    const t = Math.min(1, dur * 0.3);
    const args = [
      '-ss', String(t), '-i', path.resolve(file),
      '-vf', 'edgedetect,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-frames:v', '1', '-f', 'null', '-',
    ];
    const { stderr, code } = await run(config.FFMPEG_PATH, args, { timeout: 40000 });
    if (code !== 0) return { score: null, note: 'edgedetect 不可用' };
    const m = stderr.match(/YAVG=([\d.]+)/g);
    if (!m) return { score: null };
    const vals = m.map((x) => parseFloat(x.replace('YAVG=', '')));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { score: +avg.toFixed(2) };
  } catch (e) {
    return { score: null, note: '检测失败' };
  }
}

// 镜头切分（scene 变化检测），返回切点（秒）
async function sceneCuts(file, threshold = 0.3) {
  const args = [
    '-i', path.resolve(file),
    '-filter:v', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ];
  const { stderr } = await run(config.FFMPEG_PATH, args, { timeout: 60000 });
  const cuts = [];
  const re = /showinfo.*?pts_time:([\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) cuts.push(+m[1]);
  return cuts;
}

module.exports = {
  run, parseProgress, probe, thumbnail, detectBlack, detectSilence,
  motionScore, sharpnessScore, sceneCuts, FFMPEG_PATH: config.FFMPEG_PATH, FFPROBE_PATH: config.FFPROBE_PATH,
};
