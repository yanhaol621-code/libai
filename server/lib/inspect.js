// inspect.js - 素材深度审核引擎（画面 + 音频 + 重复 + 评分 + 分类）
// 全部基于本机 FFmpeg 真实解码，无外部 API、无随机值、无占位。
// 原则：可测的量就测准；测不准的（产品主体/遮挡/LOGO 清晰度）一律标「待人工确认」，不猜。

const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const SIZE = 32;              // 采样帧分辨率（灰阶）
const AREA = SIZE * SIZE;

// ============ 1. 抽帧 ============
// 按固定 fps 抽取灰阶小图，返回连续帧数组（用于指纹、亮度、清晰度、运动、抖动）
async function grabFrames(file, { fps = 8, maxFrames = 1500, timeout = 240000 } = {}) {
  const tmp = path.join(config.DIRS.temp, `fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.raw`);
  const args = [
    '-y', '-i', path.resolve(file), '-an',
    '-vf', `fps=${fps},scale=${SIZE}:${SIZE}:flags=area,format=gray`,
    '-f', 'rawvideo', path.resolve(tmp),
  ];
  const { code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, args, { timeout });
  if (code !== 0) throw new Error('抽帧失败: ' + String(stderr || '').slice(-200));
  let buf;
  try {
    buf = await fs.readFile(tmp);
  } finally {
    try { await fs.unlink(tmp); } catch (_) {}
  }
  const n = Math.floor(buf.length / AREA);
  const frames = new Array(Math.min(n, maxFrames));
  for (let i = 0; i < frames.length; i++) {
    frames[i] = buf.subarray(i * AREA, (i + 1) * AREA);
  }
  return frames;
}

// ============ 2. 单帧指标 ============
// 平均哈希（8x8 → 64bit）：用于重复镜头比对
function aHash(f) {
  const small = new Float64Array(64);
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let s = 0;
      for (let y = 0; y < 4; y++) {
        const row = (by * 4 + y) * SIZE + bx * 4;
        s += f[row] + f[row + 1] + f[row + 2] + f[row + 3];
      }
      small[by * 8 + bx] = s / 16;
    }
  }
  let mean = 0;
  for (let i = 0; i < 64; i++) mean += small[i];
  mean /= 64;
  const out = new Uint8Array(8);
  for (let i = 0; i < 64; i++) {
    if (small[i] >= mean) out[i >> 3] |= (0x80 >> (i & 7));
  }
  return out;
}

function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 8; i++) {
    let x = a[i] ^ b[i];
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

// 亮度均值 + 过曝/欠曝像素占比
function brightness(f) {
  let sum = 0, over = 0, under = 0;
  for (let i = 0; i < AREA; i++) {
    const v = f[i];
    sum += v;
    if (v >= 250) over++;
    else if (v <= 5) under++;
  }
  const mean = sum / AREA;
  return { mean: +mean.toFixed(1), over: +(over / AREA).toFixed(3), under: +(under / AREA).toFixed(3) };
}

// 清晰度：拉普拉斯方差（32x32 内部区域，避开边缘）
function sharpness(f) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const i = y * SIZE + x;
      const l = 4 * f[i] - f[i - 1] - f[i + 1] - f[i - SIZE] - f[i + SIZE];
      sum += l; sum2 += l * l; n++;
    }
  }
  const m = sum / n;
  const varr = sum2 / n - m * m;
  return +Math.sqrt(Math.max(0, varr)).toFixed(2); // 0~100+，越大越锐利
}

// ============ 3. 帧间对齐：一次算出位移(抖动) + 残差(内容变化/冻结/跳变) ============
// 在 ±R 像素内搜索使两帧差异最小的平移量；shift=相机位移，residual=对齐后仍存在的画面变化
const R = 4;
const WIN = SIZE - 2 * R; // 只用中心区域比对，避免越界
function alignFrames(a, b) {
  let best = Infinity, bdx = 0, bdy = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      for (let y = 0; y < WIN; y++) {
        const ra = (y + R) * SIZE + R;
        const rb = (y + R + dy) * SIZE + R + dx;
        for (let x = 0; x < WIN; x++) {
          const d = a[ra + x] - b[rb + x];
          s += d < 0 ? -d : d;
        }
      }
      if (s < best) { best = s; bdx = dx; bdy = dy; }
    }
  }
  return { dx: bdx, dy: bdy, residual: best / (WIN * WIN) };
}

// ============ 4. 画面审核 ============
async function inspectVideo(file, duration, onStage) {
  // 采样 fps：长视频降采样，保证总帧数可控（约 300~500 帧）
  const fps = Math.max(2, Math.min(10, +(400 / Math.max(1, duration)).toFixed(2)));
  const stage = (s) => { if (onStage) onStage(s); };
  stage('抽帧');
  const frames = await grabFrames(file, { fps });
  if (!frames.length) throw new Error('无法解码画面');

  stage('计算画面指标');
  const n = frames.length;
  const hashes = new Array(n);
  const bright = new Array(n);
  const sharp = new Array(n);
  for (let i = 0; i < n; i++) {
    hashes[i] = aHash(frames[i]);
    bright[i] = brightness(frames[i]);
    sharp[i] = sharpness(frames[i]);
  }

  stage('检测抖动与冻结');
  const shifts = new Array(n);
  const residuals = new Array(n);
  for (let i = 1; i < n; i++) {
    const r = alignFrames(frames[i - 1], frames[i]);
    shifts[i] = Math.hypot(r.dx, r.dy);
    residuals[i] = r.residual;
  }
  shifts[0] = 0; residuals[0] = 0;

  // --- 冻结（画面长时间几乎不变）---
  const FREEZE_RES = 1.6;      // 对齐后残差低于此值视为"没变化"
  const freezeSegs = [];
  let fs0 = -1;
  for (let i = 1; i < n; i++) {
    const frozen = residuals[i] < FREEZE_RES;
    if (frozen && fs0 < 0) fs0 = i - 1;
    if ((!frozen || i === n - 1) && fs0 >= 0) {
      const len = (i - fs0) / fps;
      if (len >= 0.6) freezeSegs.push({ start: +(fs0 / fps).toFixed(2), end: +(i / fps).toFixed(2), duration: +len.toFixed(2) });
      fs0 = -1;
    }
  }
  const freezeTotal = freezeSegs.reduce((a, b) => a + b.duration, 0);

  // --- 跳变（相邻帧残差突增，非预期切换）---
  const JUMP_RES = 55;
  const jumps = [];
  for (let i = 1; i < n; i++) {
    if (residuals[i] > JUMP_RES) jumps.push(+(i / fps).toFixed(2));
  }

  // --- 抖动评分：位移幅度 + 方向反复（手持晃动特征）---
  let dirFlip = 0, shiftSum = 0, shiftMax = 0, moveFrames = 0;
  let prevDx = 0;
  for (let i = 1; i < n; i++) {
    shiftSum += shifts[i];
    if (shifts[i] > shiftMax) shiftMax = shifts[i];
    if (shifts[i] > 0.5) moveFrames++;
    // 用残差符号变化近似方向变化（配合位移幅度判断是否为来回抖）
    const cur = residuals[i] > residuals[i - 1] ? 1 : -1;
    if (i > 1 && cur !== prevDx) dirFlip++;
    prevDx = cur;
  }
  const shiftMean = n > 1 ? shiftSum / (n - 1) : 0;
  const moveRatio = n > 1 ? moveFrames / (n - 1) : 0;
  const flipRatio = n > 2 ? dirFlip / (n - 2) : 0;
  // 抖动 = 平均位移 × (0.6 + 方向反复率)，再乘以持续运动占比，避免"缓慢平移"被误判
  const shake = +(shiftMean * (0.6 + flipRatio) * (0.4 + moveRatio) * 10).toFixed(2);

  // --- 曝光 ---
  let overFrames = 0, underFrames = 0;
  for (let i = 0; i < n; i++) {
    if (bright[i].over > 0.25) overFrames++;
    if (bright[i].under > 0.35) underFrames++;
  }
  const overRatio = overFrames / n;
  const underRatio = underFrames / n;

  // --- 清晰度统计 ---
  const sharpVals = sharp.slice().sort((a, b) => a - b);
  const sharpMed = sharpVals[Math.floor(n / 2)] || 0;
  const sharpP10 = sharpVals[Math.floor(n * 0.1)] || 0;
  let blurryFrames = 0;
  for (let i = 0; i < n; i++) if (sharp[i] < Math.max(3, sharpMed * 0.45)) blurryFrames++;
  const blurryRatio = blurryFrames / n;

  // --- 有效区间：去掉开头/结尾的黑屏、纯色、失焦、冻结 ---
  // 单帧"可用"判定：不是全黑/全白、不是失焦、不在冻结段内
  const inFreeze = (t) => freezeSegs.some((s) => t >= s.start && t <= s.end);
  const frameOk = (i) => {
    const b = bright[i];
    if (b.mean < 12 || b.mean > 245) return false;      // 全黑 / 全白
    if (b.under > 0.6 || b.over > 0.6) return false;
    if (sharp[i] < Math.max(2.5, sharpMed * 0.35)) return false; // 严重失焦
    if (inFreeze(i / fps)) return false;
    return true;
  };
  let head = 0, tail = n - 1;
  while (head < n && !frameOk(head)) head++;
  while (tail > head && !frameOk(tail)) tail--;
  // 允许中间有零星坏帧：只要连续可用段覆盖即可，取首尾第一个/最后一个可用帧
  const trimIn = head >= n ? 0 : +(head / fps).toFixed(2);
  const trimOut = head >= n ? 0 : +((tail + 1) / fps).toFixed(2);
  const validDur = +(trimOut - trimIn).toFixed(2);

  // 中间无效段（有效区间内部的坏块，供裁切参考）
  const badSegs = [];
  let bs = -1;
  for (let i = head; i <= tail; i++) {
    const bad = !frameOk(i);
    if (bad && bs < 0) bs = i;
    if ((!bad || i === tail) && bs >= 0) {
      const len = (i - bs) / fps;
      if (len >= 0.5) badSegs.push({ start: +(bs / fps).toFixed(2), end: +(i / fps).toFixed(2), duration: +len.toFixed(2), reason: '画面异常' });
      bs = -1;
    }
  }

  return {
    sampleFps: fps, frameCount: n,
    hashes: hashes.map((h) => Buffer.from(h).toString('hex')),
    bright: { mean: +(bright.reduce((a, b) => a + b.mean, 0) / n).toFixed(1), overRatio: +overRatio.toFixed(3), underRatio: +underRatio.toFixed(3) },
    sharp: { median: +sharpMed.toFixed(2), p10: +sharpP10.toFixed(2), blurryRatio: +blurryRatio.toFixed(3) },
    freeze: { segments: freezeSegs, total: +freezeTotal.toFixed(2) },
    jumps,
    shake: { score: shake, shiftMean: +shiftMean.toFixed(2), shiftMax: +shiftMax.toFixed(2), moveRatio: +moveRatio.toFixed(2) },
    valid: { in: trimIn, out: trimOut, duration: validDur, durationSrc: +duration.toFixed(2), badSegments: badSegs },
  };
}

// ============ 5. 音频审核 ============
// 真实测量：EBU R128 综合响度/动态范围/真峰值 + 静音区间
async function inspectAudio(file, onStage) {
  const stage = (s) => { if (onStage) onStage(s); };
  stage('音频响度测量');
  const { stderr } = await ffmpeg.run(config.FFMPEG_PATH, [
    '-i', path.resolve(file), '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { timeout: 240000 });
  // 只取结尾的 Summary 段：ebur128 会边播边打实时表(I/S/M)，首秒的瞬时值不是结论
  const raw = String(stderr || '');
  const si = raw.lastIndexOf('Summary:');
  const txt = si >= 0 ? raw.slice(si) : raw;
  const pick = (re) => { const m = txt.match(re); return m ? parseFloat(m[1]) : null; };
  const integrated = pick(/\bI:\s*(-?[\d.]+)\s*LUFS/);
  const lra = pick(/\bLRA:\s*(-?[\d.]+)\s*LU/);
  const truePeak = pick(/Peak:\s*(-?[\d.]+)\s*dBFS/);

  stage('静音与有效声段检测');
  const silences = await ffmpeg.detectSilence(file, { noise: -35, duration: 0.5 }).catch(() => []);

  // 电平分布（astats）：判断爆音/底噪
  stage('音频电平分析');
  const st = await ffmpeg.run(config.FFMPEG_PATH, [
    '-i', path.resolve(file), '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-',
  ], { timeout: 240000 }).catch(() => ({ stderr: '' }));
  // astats 同样只在结尾 Overall 段出结论，前面是逐帧元数据
  const sRaw = String(st.stderr || '');
  const oi = sRaw.lastIndexOf('Overall');
  const stTxt = oi >= 0 ? sRaw.slice(oi) : sRaw;
  const flat = pick2(stTxt, /Flat_factor/);
  const peak = pick2(stTxt, /Peak_level/);
  const noiseFloor = pick2(stTxt, /Noise_floor/);

  return {
    integrated,                 // LUFS，越接近 -16~-14 越好（短视频平台常用）
    lra,                        // 响度动态范围
    truePeak,                   // dBFS，> -1 视为削波风险
    peakLevel: peak,
    noiseFloor,
    flatFactor: flat,
    silences,
    silenceTotal: +(silences.reduce((a, b) => a + (b.duration || 0), 0)).toFixed(2),
  };
}

function pick2(txt, re) {
  const m = txt.match(new RegExp(re.source + '[\\s\\S]{0,80}?(-?[\\d.]+)', 'i'));
  return m ? parseFloat(m[1]) : null;
}

// ============ 6. 评分与分类 ============
// 0~100 分，且必须给出可解释的加减分原因
function scoreMaterial(m, rep) {
  const reasons = [];
  let score = 100;

  // --- 画面 ---
  if (rep.sharp) {
    const med = rep.sharp.median;
    if (med < 4) { score -= 35; reasons.push(`清晰度很低(锐度${med})，主体可能失焦`); }
    else if (med < 8) { score -= 15; reasons.push(`清晰度偏低(锐度${med})`); }
    else if (med > 25) { score += 5; reasons.push(`画面锐利(锐度${med})`); }
    if (rep.sharp.blurryRatio > 0.4) { score -= 20; reasons.push(`${Math.round(rep.sharp.blurryRatio * 100)}% 的帧偏模糊`); }
  }
  if (rep.bright) {
    if (rep.bright.overRatio > 0.25) { score -= 18; reasons.push(`${Math.round(rep.bright.overRatio * 100)}% 的帧过曝`); }
    if (rep.bright.underRatio > 0.25) { score -= 18; reasons.push(`${Math.round(rep.bright.underRatio * 100)}% 的帧欠曝`); }
  }
  if (rep.freeze && rep.freeze.total > 0) {
    const r = rep.freeze.total / Math.max(1, rep.valid.durationSrc || 1);
    if (r > 0.5) { score -= 40; reasons.push(`画面冻结 ${rep.freeze.total.toFixed(1)}s（占 ${Math.round(r * 100)}%）`); }
    else if (rep.freeze.total > 0.6) { score -= 18; reasons.push(`存在冻结片段 ${rep.freeze.total.toFixed(1)}s`); }
  }
  if (rep.shake) {
    if (rep.shake.score > 55) { score -= 25; reasons.push(`抖动明显(抖动值${rep.shake.score})`); }
    else if (rep.shake.score > 30) { score -= 10; reasons.push(`轻微抖动(抖动值${rep.shake.score})`); }
  }
  if (rep.jumps && rep.jumps.length > 2) { score -= 8 * Math.min(3, rep.jumps.length - 2); reasons.push(`检测到 ${rep.jumps.length} 处画面跳变`); }
  if (rep.valid) {
    const src = rep.valid.durationSrc || 1;
    const cut = src - rep.valid.duration;
    if (cut > 0.5 && cut / src > 0.25) reasons.push(`首尾无效 ${cut.toFixed(1)}s，已自动裁切`);
    if (rep.valid.duration < 1) { score -= 45; reasons.push(`有效内容不足 1 秒`); }
    if (rep.valid.badSegments && rep.valid.badSegments.length) {
      score -= 6 * Math.min(3, rep.valid.badSegments.length);
      reasons.push(`中间有 ${rep.valid.badSegments.length} 段异常画面`);
    }
  }
  if (rep.blackTotal > 0.5) { score -= 20; reasons.push(`含黑屏 ${rep.blackTotal.toFixed(1)}s`); }

  // --- 音频 ---
  if (rep.audio) {
    const a = rep.audio;
    if (a.integrated !== null && a.integrated !== undefined) {
      if (a.integrated < -30) { score -= 12; reasons.push(`声音过小(${a.integrated.toFixed(1)} LUFS)`); }
      else if (a.integrated > -5) { score -= 10; reasons.push(`声音过大(${a.integrated.toFixed(1)} LUFS)`); }
    }
    // 短视频平台成品普遍限制在 +1 dBTP 以内；超过才算真削波
    if (a.truePeak !== null && a.truePeak > 1) { score -= 15; reasons.push(`存在削波(真峰值 +${a.truePeak.toFixed(1)} dBFS)`); }
    else if (a.truePeak !== null && a.truePeak > -0.5) { score -= 4; reasons.push(`峰值偏高(真峰值 ${a.truePeak.toFixed(1)} dBFS)`); }
    const sr = a.silenceTotal / Math.max(1, rep.valid ? rep.valid.durationSrc : 1);
    if (sr > 0.9) { score -= 10; reasons.push(`几乎全程静音`); }
    if (a.lra !== null && a.lra > 20) { score -= 6; reasons.push(`音量起伏过大(LRA ${a.lra.toFixed(1)})`); }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  if (!reasons.length) reasons.push('画面清晰稳定、曝光正常、音频可用');
  return { score, reasons };
}

// 归入 8 个桶之一（用于审核页分组）
function bucketOf(m, rep) {
  const src = (rep && rep.valid && rep.valid.durationSrc) || m.duration || 0;
  const validDur = (rep && rep.valid && rep.valid.duration) || 0;
  if (rep && rep.duplicateOf) return '重复素材';
  if (!rep || rep.error) return '无效素材';

  const hardBad =
    (rep.sharp && rep.sharp.median < 3) ||
    (rep.freeze && src > 0 && rep.freeze.total / src > 0.6) ||
    (rep.bright && (rep.bright.overRatio > 0.5 || rep.bright.underRatio > 0.5)) ||
    validDur < 0.8;
  if (hardBad) return '无效素材';

  const cut = src - validDur;
  const needTrim = cut > 0.5;
  const shaky = rep.shake && rep.shake.score > 30;
  const blurry = rep.sharp && rep.sharp.blurryRatio > 0.25;
  const audioBad = rep.audio && (
    (rep.audio.truePeak !== null && rep.audio.truePeak > 1) ||
    (rep.audio.integrated !== null && (rep.audio.integrated < -32 || rep.audio.integrated > -5))
  );

  const jumpy = rep.jumps && rep.jumps.length > 3;
  // 画面问题比音频问题更直观，优先归类
  if ((shaky || blurry || jumpy) && !needTrim) return '画面异常';
  if ((shaky || blurry || jumpy) && needTrim) return '可修复';
  if (needTrim) return '可裁切优化';
  if (audioBad) return '音频异常';
  // 评分或置信度不足 → 交给人工
  if (rep.score && rep.score.score < 55) return '待确认';
  return '优质可用';
}

// ============ 7. 重复镜头识别（跨素材） ============
// 用平均哈希逐帧比对：两个素材若有连续多帧指纹高度接近，判定为重复拍摄
const DUP_HASH_DIST = 10;   // 单帧汉明距离阈值（0~64）
const DUP_MIN_FRAMES = 4;   // 至少 N 个采样帧命中
function findDuplicates(materials) {
  const list = materials.filter((m) => m.inspect && m.inspect.hashes && m.inspect.hashes.length);
  const parse = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
  const cache = new Map();
  const getH = (m) => {
    if (!cache.has(m.id)) cache.set(m.id, m.inspect.hashes.map(parse));
    return cache.get(m.id);
  };
  // 两两比对，计算"命中率"：A 中有多少帧能在 B 里找到近似帧
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      const ha = getH(A), hb = getH(B);
      // 稀疏采样比对（最多各取 60 帧）以控制耗时
      const stepA = Math.max(1, Math.floor(ha.length / 60));
      const stepB = Math.max(1, Math.floor(hb.length / 60));
      let hit = 0, total = 0;
      for (let x = 0; x < ha.length; x += stepA) {
        let best = 64;
        for (let y = 0; y < hb.length; y += stepB) {
          const d = hamming(ha[x], hb[y]);
          if (d < best) best = d;
          if (best <= DUP_HASH_DIST) break;
        }
        total++;
        if (best <= DUP_HASH_DIST) hit++;
      }
      const ratio = total ? hit / total : 0;
      if (hit >= DUP_MIN_FRAMES && ratio >= 0.35) {
        markDup(A, B, ratio);
      }
    }
  }
  return list;
}

function markDup(A, B, ratio) {
  const sa = (A.inspect && A.inspect.score && A.inspect.score.score) || 0;
  const sb = (B.inspect && B.inspect.score && B.inspect.score.score) || 0;
  // 分数高的当"保留版"，低的当"重复版"；分数相同则清晰度高者优先
  const saAll = (A.inspect && A.inspect.sharp && A.inspect.sharp.median) || 0;
  const sbAll = (B.inspect && B.inspect.sharp && B.inspect.sharp.median) || 0;
  const aBetter = sa === sb ? saAll >= sbAll : sa > sb;
  const keeper = aBetter ? A : B;
  const dup = aBetter ? B : A;
  dup.inspect.duplicateOf = keeper.id;
  dup.inspect.duplicateRatio = +ratio.toFixed(2);
  keeper.inspect.duplicateKeep = (keeper.inspect.duplicateKeep || []);
  if (!keeper.inspect.duplicateKeep.includes(dup.id)) keeper.inspect.duplicateKeep.push(dup.id);
}

// ============ 8. 主入口：审核单个素材 ============
async function inspectMaterial(projectId, mat, onStage) {
  const filePath = path.join(config.materialDir(projectId), mat.filename);
  const rep = { at: new Date().toISOString(), engine: 'ffmpeg-local' };
  try {
    if (mat.type === 'image') {
      rep.kind = 'image';
      rep.valid = { in: 0, out: 0, duration: 0, durationSrc: 0, badSegments: [] };
      rep.bright = null; rep.sharp = null; rep.freeze = null; rep.shake = null; rep.jumps = [];
      rep.audio = null;
      rep.score = { score: 75, reasons: ['图片素材由人工确认展示价值'] };
      rep.bucket = '待确认';
      return rep;
    }
    const v = await inspectVideo(filePath, mat.duration || 0, onStage);
    Object.assign(rep, v);
    rep.blackTotal = 0;
    const black = await ffmpeg.detectBlack(filePath).catch(() => []);
    rep.blackSegments = black;
    rep.blackTotal = +(black.reduce((a, b) => a + b.duration, 0)).toFixed(2);

    if (mat.hasAudio) rep.audio = await inspectAudio(filePath, onStage);
    else rep.audio = null;

    rep.score = scoreMaterial(mat, rep);
    rep.bucket = bucketOf(mat, rep);
    return rep;
  } catch (e) {
    rep.error = e.message;
    rep.bucket = '无效素材';
    return rep;
  }
}

// ============ 9. 汇总报告 ============
function buildReport(materials) {
  const total = materials.length;
  const srcDur = materials.reduce((a, m) => a + (m.duration || 0), 0);
  const buckets = {};
  for (const m of materials) {
    const b = (m.inspect && m.inspect.bucket) || '待确认';
    buckets[b] = (buckets[b] || 0) + 1;
  }
  const usable = materials.filter((m) => {
    const b = (m.inspect && m.inspect.bucket);
    return b === '优质可用' || b === '可裁切优化' || b === '可修复';
  });
  const usableDur = usable.reduce((a, m) => a + ((m.inspect && m.inspect.valid && m.inspect.valid.duration) || m.duration || 0), 0);
  return {
    total,
    srcDuration: +srcDur.toFixed(1),
    buckets,
    counts: {
      total,
      good: buckets['优质可用'] || 0,
      trimmable: buckets['可裁切优化'] || 0,
      fixable: buckets['可修复'] || 0,
      duplicate: buckets['重复素材'] || 0,
      videoBad: buckets['画面异常'] || 0,
      audioBad: buckets['音频异常'] || 0,
      invalid: buckets['无效素材'] || 0,
      pending: buckets['待确认'] || 0,
    },
    usableCount: usable.length,
    usableDuration: +usableDur.toFixed(1),
    at: new Date().toISOString(),
  };
}

module.exports = {
  inspectMaterial, inspectVideo, inspectAudio, buildReport,
  findDuplicates, scoreMaterial, bucketOf,
  grabFrames, aHash, hamming, sharpness, brightness, alignFrames,
};
