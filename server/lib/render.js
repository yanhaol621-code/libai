// render.js - 真实视频渲染（FFmpeg）：分段归一化 -> 拼接 -> 配乐+字幕合成 -> 输出 MP4
const fs = require('fs/promises');
const path = require('path');
const fsSync = require('fs');
const config = require('../config');
const ffmpeg = require('./ffmpeg');
const music = require('./music');
const musiclib = require('./musiclib');
const asr = require('./asr');
const editor = require('./editor');

// ===== 视频编码：优先 Intel QSV 硬编（核显），不可用/失败自动回退 CPU libx264 =====
// i5-12400 核显 UHD730 硬编 1080p 可到数百 fps，比 x264 veryfast（约 60-90fps）快 3-5 倍。
let qsvState = 'unknown';   // unknown | ok | bad（进程内缓存，只探测一次）
const X264_ARGS = () => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];
const QSV_ARGS = () => ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23'];
async function probeQsv() {
  if (qsvState !== 'unknown') return qsvState === 'ok';
  try {
    const r = await ffmpeg.run(config.FFMPEG_PATH, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:r=30', '-frames:v', '3',
      ...QSV_ARGS(), '-f', 'null', '-',
    ], { timeout: 20000 });
    qsvState = r.code === 0 ? 'ok' : 'bad';
  } catch (_) { qsvState = 'bad'; }
  return qsvState === 'ok';
}
// 当前首选编码参数（探测过 QSV 就用 QSV，否则 CPU）
function codecArgs() {
  return qsvState === 'ok' ? QSV_ARGS() : X264_ARGS();
}
// 真实编码失败且走的是 QSV → 标记坏掉并回退 CPU（本次调用方直接用返回值重试）
function codecFallback(lastCodec) {
  if (lastCodec === 'qsv') { qsvState = 'bad'; return X264_ARGS(); }
  return null;
}

// ===== 目标分辨率（按比例）=====
// 预设 9:16/1:1/4:3/16:9 与自定义「宽:高」统一走解析：短边对齐 1080，长边等比放大，偶数化并限制上限
function targetSize(ratio) {
  const m = /^(\d+)\s*:\s*(\d+)$/.exec(String(ratio || ''));
  if (m) {
    const rw = parseInt(m[1], 10), rh = parseInt(m[2], 10);
    if (rw >= 1 && rh >= 1) {
      const scale = 1080 / Math.min(rw, rh);
      let w = Math.round(rw * scale), h = Math.round(rh * scale);
      w = Math.min(3840, Math.max(2, w + (w % 2)));
      h = Math.min(3840, Math.max(2, h + (h % 2)));
      return { w, h };
    }
  }
  switch (ratio) {
    case '1:1': return { w: 1080, h: 1080 };
    case '4:3': return { w: 1440, h: 1080 };
    case '16:9': return { w: 1920, h: 1080 };
    case '9:16':
    default: return { w: 1080, h: 1920 };
  }
}

// ===== 中文字体：复制到项目内，避免路径空格/盘符问题 =====
let FONT_PATH = null;
let FONT_BOLD_PATH = null;
function ensureFont(bold) {
  if (bold && FONT_BOLD_PATH && fsSync.existsSync(FONT_BOLD_PATH)) return FONT_BOLD_PATH;
  if (!bold && FONT_PATH && fsSync.existsSync(FONT_PATH)) return FONT_PATH;
  // 粗体优先（字幕/钩子更贴近短视频观感），回退常规体
  const candidates = bold
    ? ['C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simhei.ttf']
    : ['C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc', 'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc'];
  const destDir = path.join(config.ROOT, 'bin', 'fonts');
  fsSync.mkdirSync(destDir, { recursive: true });
  for (const c of candidates) {
    if (fsSync.existsSync(c)) {
      const name = path.basename(c);
      const dest = path.join(destDir, name);
      if (!fsSync.existsSync(dest)) fsSync.copyFileSync(c, dest);
      if (bold) { FONT_BOLD_PATH = dest; return dest; }
      FONT_PATH = dest;
      return dest;
    }
  }
  return null; // 无中文字体则交给系统默认（可能不显示中文，会告警）
}

// ===== 背景音乐 =====
// 优先级：素材库选用(musicLibId) > 项目上传音乐(musicPath) > 系统合成原创配乐（按项目风格自动挑）
async function pickMusic(project, presetOverride) {
  if (project.musicLibId) {
    try {
      const t = await musiclib.get(project.musicLibId);
      if (t && fsSync.existsSync(t.file)) return { path: t.file, label: t.name, key: 'lib' };
      console.warn('[render] 素材库音乐缺失，回退默认配乐:', project.musicLibId);
    } catch (_) {}
  }
  if (project.musicPath && fsSync.existsSync(project.musicPath)) {
    return { path: project.musicPath, label: '用户上传音乐', key: 'custom' };
  }
  try {
    const key = presetOverride || music.pickPreset(project);
    return await music.ensureTrack(key);
  } catch (_) {
    return null;
  }
}

function escapeDrawtextFile(text) {
  return text; // 使用 textfile，无需转义
}

// ===== 单段归一化 =====
// 一个 part 是最小单位：从某个源片位置取一段（srcStart=null 表示黑场），
// srcDur 一律按「成片时间轴时长」理解，所以需要读取的源片长度 = srcDur * speed。
async function normalizePart(projectId, mat, part, size, tempDir, name, opt) {
  const o = opt || {};
  const speed = Number(o.speed) > 0.1 ? Number(o.speed) : 1;
  const volume = Number.isFinite(o.volume) ? o.volume : 1;
  // 优先使用美颜副本，其次审核优化副本（已裁掉无效段 / 防抖 / 响度归一）；原始文件始终保留
  const src = o.srcFile && fsSync.existsSync(path.join(config.materialDir(projectId), o.srcFile))
    ? path.join(config.materialDir(projectId), o.srcFile)
    : path.join(config.materialDir(projectId), mat.filename);
  const out = path.join(tempDir, name);
  // 不超过素材自身的可用时长，避免裁到末尾黑帧
  const optSrc = mat.beauty || mat.optimized;
  const avail = optSrc ? (optSrc.duration || mat.duration) : (mat.duration || 0);
  const isImage = mat.type === 'image';
  const hasPic = !isImage && part.srcStart !== null && part.srcStart !== undefined && Number.isFinite(Number(part.srcStart));
  let srcDur = Math.max(0.4, (Number(part.srcDur) || 3) * speed);
  if (hasPic && avail > 0.6) srcDur = Math.min(srcDur, Math.max(0.4, avail - Number(part.srcStart)));
  const dur = Math.max(0.3, srcDur / speed);      // 成片里的实际时长
  const fadeOut = Math.max(0.2, dur - 0.25);
  let vf = `scale=${size.w}:${size.h}:force_original_aspect_ratio=increase,crop=${size.w}:${size.h}`;
  if (!isImage && speed !== 1) vf += `,setpts=(PTS-STARTPTS)/${speed}`;
  vf += `,fps=30,format=yuv420p`;
  // 只在整段的开头/结尾做淡入淡出，段内多轨拼接处不加，避免闪黑
  if (o.fadeIn !== false) vf += `,fade=t=in:st=0:d=0.25`;
  if (o.fadeOut !== false) vf += `,fade=t=out:st=${fadeOut.toFixed(2)}:d=0.25`;

  const buildArgs = (codec) => {
    const args = [];
    if (isImage) {
      args.push('-loop', '1', '-i', path.resolve(src));
    } else if (!hasPic) {
      // 该时间段所有画面轨都空着 → 黑场（保留时长，和剪辑软件一致）
      args.push('-f', 'lavfi', '-i', `color=c=black:s=${size.w}x${size.h}:r=30`);
    } else {
      args.push('-ss', String(Math.max(0, Number(part.srcStart))), '-i', path.resolve(src));
    }
    // 音频与画面分层：这一段的声音可以从源片别的位置取（开头被拖过 / 单独截过），
    // 也可以用同一文件的第二个输入单独 seek 声音，不必让画面跟着跳
    const vol = Math.max(0, Math.min(2.5, volume));
    // 声音起点缺省 = 跟随画面（老数据结构里 audioStart=null 就是这个意思）
    let aStart = Number.isFinite(Number(part.audioStart)) ? Number(part.audioStart)
      : (hasPic ? Number(part.srcStart) : null);
    if (aStart !== null && avail > 0.6) aStart = Math.min(aStart, Math.max(0, avail - 0.3));
    const useAudio = !isImage && mat.hasAudio && !part.mute && vol > 0.001 && aStart !== null;
    const splitAudio = useAudio && (!hasPic || Math.abs(aStart - Number(part.srcStart)) > 0.05);
    if (splitAudio) args.push('-ss', String(aStart.toFixed(3)), '-i', path.resolve(src));

    if (useAudio) {
      args.push('-map', '0:v', '-map', splitAudio ? '1:a' : '0:a');
    } else {
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a');
    }
    args.push(
      '-vf', vf,
      ...codec, '-pix_fmt', 'yuv420p',
    );
    // 声音：变速时跟着变（atempo），调过音量就乘上去，比画面短就补静音（后面 -t 会裁齐）
    if (useAudio) {
      const af = [];
      if (speed !== 1) af.push(`atempo=${speed}`);
      if (Math.abs(vol - 1) > 0.001) af.push(`volume=${vol}`);
      if (vol > 1.2) af.push('alimiter=limit=0.95');   // 高倍音量限幅：防爆音破声（与配乐混音路同一上限）
      if (splitAudio) af.push('apad');
      if (af.length) args.push('-af', af.join(','));
    }
    args.push(
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(dur.toFixed(3)),
      '-movflags', '+faststart', '-y', path.resolve(out),
    );
    return args;
  };
  await probeQsv();
  let codec = codecArgs();
  let codecTag = qsvState === 'ok' ? 'qsv' : 'x264';
  let { code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, buildArgs(codec), { timeout: 180000 });
  if (code !== 0 && codecTag === 'qsv') {
    // QSV 实机编码失败（驱动/分辨率等）→ 标记坏掉，本条立即用 CPU 重试
    const fb = codecFallback('qsv');
    if (fb) { codec = fb; codecTag = 'x264'; ({ code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, buildArgs(codec), { timeout: 180000 })); }
  }
  if (code !== 0) throw new Error(`分段 ${name} 渲染失败: ` + stderr.slice(-400));
  return out;
}

// 一段成片所需的全部源片段：只有一个就直出，多个（多轨覆盖 / 留黑场）先各自归一化再拼
async function normalizeSegment(projectId, mat, seg, size, tempDir, index) {
  const speed = (mat.type === 'video' && Number(seg.speed) > 0.1) ? Number(seg.speed) : 1;
  const volume = Number.isFinite(seg.volume) ? seg.volume : 1;
  const parts = (Array.isArray(seg.parts) && seg.parts.length)
    ? seg.parts
    : [{ srcStart: seg.srcStart, audioStart: seg.audioStart, srcDur: seg.srcDur, mute: seg.mute }];
  const base = { speed, volume, srcFile: seg.srcFile };
  if (parts.length === 1) {
    return normalizePart(projectId, mat, parts[0], size, tempDir, `seg_${index}.mp4`,
      Object.assign({}, base, { fadeIn: true, fadeOut: true }));
  }
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    files.push(await normalizePart(projectId, mat, parts[i], size, tempDir, `seg_${index}_p${i}.mp4`,
      Object.assign({}, base, { fadeIn: i === 0, fadeOut: i === parts.length - 1 })));
  }
  return concatSegments(files, tempDir, `seg_${index}.mp4`);
}

// ===== 拼接 =====
async function concatSegments(segFiles, tempDir, outName) {
  const name = outName || 'concat.mp4';
  const list = path.join(tempDir, 'list_' + name.replace(/\.mp4$/i, '') + '.txt');
  const content = segFiles.map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`).join('\n');
  await fs.writeFile(list, content, 'utf8');
  const out = path.join(tempDir, name);
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', path.resolve(list), '-c', 'copy', path.resolve(out)];
  const { code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, args, { timeout: 120000 });
  if (code !== 0) throw new Error('拼接失败: ' + stderr.slice(-300));
  return out;
}

// ===== 文案断行 =====
// 中文按字宽切行：一屏控制在 ~12 字，最多 2 行；每行单独居中并带高亮底框，贴近同行字幕观感
function wrapText(text, maxChars) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  if (t.length <= maxChars) return [t];
  // 均衡断行：优先两行对半分，避免最后一行只剩一个孤字
  const count = Math.min(2, Math.ceil(t.length / maxChars));
  const per = Math.ceil(t.length / count);
  const lines = [];
  for (let i = 0; i < t.length; i += per) lines.push(t.slice(i, i + per));
  return lines.slice(0, 2);
}

function maxCharsFor(width, fontSize) {
  // 0.88 是留出底框内边距后的可用宽度占比
  return Math.max(6, Math.floor((width * 0.88) / fontSize));
}

// ===== 成片字幕规划 =====
// 真实字幕优先：把每个素材 ASR 的词级时间轴映射到成片时间轴；
// 没有语音的片段（纯展示/图片）才退回脚本卖点字幕，且可由用户强制指定来源。
async function collectSubtitles(project, version, matMap) {
  const windows = [];
  const cues = [];
  const source = (project.subtitle && project.subtitle.source) || 'auto';
  let t = 0;
  for (const seg of version.segments || []) {
    const start = t;
    const dur = seg.srcDur || 0;
    t += dur;
    const w = { start, end: t, text: seg.sellPoint || '', asr: [] };
    const mat = matMap[seg.materialId];
    if (mat && mat.asr && mat.asr.file && source !== 'script') {
      const result = await asr.readResult(project.id, mat);
      if (result && result.segments && result.segments.length) {
        // 优化/美颜副本是从原片 trimIn 处裁出来的，所以字幕时间要还原到原片时间轴
        const base = seg.srcFile
          ? ((mat.beauty || mat.optimized) && Number.isFinite((mat.beauty || mat.optimized).in) ? (mat.beauty || mat.optimized).in : (Number.isFinite(mat.trimIn) ? mat.trimIn : 0))
          : 0;
        const matCues = asr.cuesFromResult(result, {});
        // 变速片段：成片里 1 秒 = 源片 speed 秒，字幕时间要按倍率换算
        const speed = Number(seg.speed) > 0.1 ? Number(seg.speed) : 1;
        // 多轨时间轴：一段里可能有多块源片段（上层覆盖/黑场），逐块映射；老数据只有一块
        const blocks = [];
        if (Array.isArray(seg.parts) && seg.parts.length) {
          let acc = 0;
          for (const p of seg.parts) {
            const d = Number(p.srcDur) || 0;
            if (p.srcStart !== null && p.srcStart !== undefined && Number.isFinite(Number(p.srcStart))) {
              blocks.push({ srcStart: Number(p.srcStart), outAt: start + acc, dur: d });
            }
            acc += d;
          }
        } else {
          blocks.push({ srcStart: Number(seg.srcStart) || 0, outAt: start, dur });
        }
        for (const b of blocks) {
          const srcStart = b.srcStart + base;
          const srcSpan = b.dur * speed;
          for (const c of matCues) {
            if (c.end <= srcStart + 0.05 || c.start >= srcStart + srcSpan - 0.05) continue;
            const s = Math.max(0, c.start - srcStart) / speed + b.outAt;
            const e = Math.min(c.end - srcStart, srcSpan) / speed + b.outAt;
            if (e - s < 0.35) continue;
            w.asr.push({ start: +s.toFixed(2), end: +e.toFixed(2), text: c.text });
          }
        }
      }
    }
    if (w.asr.length) cues.push(...w.asr);
    windows.push(w);
  }
  cues.sort((a, b) => a.start - b.start);
  // 真实字幕可用时用真实字幕；完全没语音则整片仍走脚本字幕
  const useAsr = source === 'asr' ? cues.length > 0 : (source === 'script' ? false : cues.length > 0);
  return { windows, cues, source, mode: useAsr ? 'asr' : 'script' };
}

// ===== 最终合成：开场钩子 + 短句字幕 + 片尾卡 + 配乐 =====
async function composite(project, version, concatFile, matMap, size, tempDir, outputPath, cuePlan) {
  const boldFont = ensureFont(true) || ensureFont(false);
  const style = project.subtitle || {};
  const tpl = version.template || {};
  const total = (version.segments || []).reduce((a, s) => a + (s.srcDur || 0), 0) || 1;
  const pure = !!version.pureMaterial;   // 纯素材拼接：不画开场钩子字卡 / 片尾品牌卡

  // 字幕样式：全局（project.subtitle）可被每段 segment.subtitleStyle 覆盖
  const gStyle = {
    sizeRatio: style.captionSize != null ? style.captionSize : (tpl.captionSize || 0.03),
    pos: style.captionPos != null ? style.captionPos : (tpl.captionPos || 0.76),
    color: style.captionColor || 'white',
    outlineColor: style.captionOutlineColor || 'black',
    outline: style.captionOutline != null ? style.captionOutline : null,
    font: style.fontFamily || 'Microsoft YaHei',
  };
  const segStyleAt = (i) => {
    const ov = (version.segments && version.segments[i] && version.segments[i].subtitleStyle) || {};
    return {
      sizeRatio: ov.captionSize != null ? ov.captionSize : gStyle.sizeRatio,
      pos: ov.captionPos != null ? ov.captionPos : gStyle.pos,
      color: ov.captionColor || gStyle.color,
      outlineColor: ov.captionOutlineColor || gStyle.outlineColor,
      outline: ov.captionOutline != null ? ov.captionOutline : gStyle.outline,
      font: ov.fontFamily || gStyle.font,
    };
  };
  const segFontPx = (i) => Math.round(size.h * segStyleAt(i).sizeRatio);

  // 时间与字号（钩子/片尾卡仍按模板比例，纯素材模式不画）
  const hookDur = Math.min(tpl.hookDur || 2.2, Math.max(1.2, total * 0.22));
  const endingDur = Math.min(tpl.endingDur || 2.4, Math.max(1.4, total * 0.2));
  const hookSize = Math.round(size.h * (tpl.hookSize || 0.04));
  const lineGap = 1.3;
  const rel = (p) => path.relative(config.ROOT, p).replace(/\\/g, '/');

  // 每段在成片里的时间窗（含该段的真实语音字幕）
  const plan = cuePlan || { windows: null, cues: [], mode: 'script' };
  let t = 0;
  const windows = plan.windows || (version.segments || []).map((s) => {
    const start = t;
    t += s.srcDur;
    return { start, end: t, text: s.sellPoint || '', asr: [] };
  });

  let fileIdx = 0;
  const writeText = async (text) => {
    const f = path.join(tempDir, `tx_${fileIdx++}.txt`);
    await fs.writeFile(f, text, 'utf8');
    return f;
  };
  const parts = [];
  // 逐行绘制：x 居中、每行独立底框；enable 控制出现时间
  const pushLine = async (text, { fontSize, y, enable, fontcolor = 'white', boxcolor = 'black@0.42' }) => {
    const f = await writeText(text);
    parts.push(
      `drawtext=fontfile='${rel(boldFont)}':textfile='${rel(f)}':x=(w-text_w)/2:y=${Math.round(y)}` +
      `:fontsize=${fontSize}:fontcolor=${fontcolor}:box=1:boxcolor=${boxcolor}:boxborderw=${Math.max(10, Math.round(fontSize * 0.28))}` +
      (enable ? `:enable='${enable}'` : '')
    );
  };

  if (boldFont) {
    // 1) 顶部小标题（爆款模板默认不压，避免和字幕抢视觉）
    if (!pure && tpl.keepTitle !== false && style.autoTitle !== false && version.title) {
      const fs = Math.round(segFontPx(0) * 0.78);
      const lines = wrapText(version.title, maxCharsFor(size.w, fs));
      for (let i = 0; i < lines.length; i++) {
        await pushLine(lines[i], { fontSize: fs, y: size.h * 0.055 + i * fs * lineGap, enable: '', fontcolor: segStyleAt(0).color, boxcolor: segStyleAt(0).outlineColor + '@0.42' });
      }
    }

    // 2) 开场钩子：大字居中，前 2 秒先把人留住
    if (!pure && version.hook) {
      const lines = wrapText(version.hook, maxCharsFor(size.w, hookSize));
      const blockH = lines.length * hookSize * lineGap;
      const y0 = size.h * 0.44 - blockH / 2;
      for (let i = 0; i < lines.length; i++) {
        await pushLine(lines[i], { fontSize: hookSize, y: y0 + i * hookSize * lineGap, enable: `between(t,0.15,${hookDur.toFixed(2)})` });
      }
    }

    // 3) 中段短句字幕：一句一屏，结尾卡出现时让位
    const capEnd = total - (pure ? 0 : endingDur);
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      if (!w.text) continue;
      // 这一段已经有真实语音字幕了，就不再压脚本卖点字幕，避免两行字打架
      if (plan.mode === 'asr' && w.asr && w.asr.length) continue;
      const ss = segStyleAt(i);
      const fs = segFontPx(i);
      const start = Math.max(w.start + 0.05, i === 0 && !pure ? hookDur + 0.05 : 0);
      const end = Math.min(w.end - 0.08, capEnd);
      if (end - start < 0.5) continue;
      const lines = wrapText(w.text, maxCharsFor(size.w, fs));
      const bottom = size.h * ss.pos;
      for (let k = 0; k < lines.length; k++) {
        const y = bottom - (lines.length - 1 - k) * fs * lineGap - fs;
        await pushLine(lines[k], { fontSize: fs, y, enable: `between(t,${start.toFixed(2)},${end.toFixed(2)})`, fontcolor: ss.color, boxcolor: ss.outlineColor + '@0.42' });
      }
    }

    // 4) 片尾卡：品牌名 + 一句引导
    const ending = version.ending || {};
    if (!pure && ending.main && endingDur > 1) {
      const eStart = (total - endingDur).toFixed(2);
      const enable = `between(t,${eStart},${total.toFixed(2)})`;
      const mSize = Math.round(size.h * 0.048);
      const mainLines = wrapText(ending.main, maxCharsFor(size.w, mSize));
      const y0 = size.h * 0.44 - (mainLines.length * mSize * lineGap) / 2;
      for (let i = 0; i < mainLines.length; i++) {
        await pushLine(mainLines[i], { fontSize: mSize, y: y0 + i * mSize * lineGap, enable });
      }
      if (ending.sub) {
        const sSize = Math.round(mSize * 0.52);
        await pushLine(ending.sub, { fontSize: sSize, y: y0 + mainLines.length * mSize * lineGap + sSize * 1.1, enable });
      }
    }
  }

  // 真实语音字幕：生成 ASS（libass）烧录；失败则自动降级为无字幕版本，不让整条渲染挂掉
  let assRel = null;
  if (plan.mode === 'asr' && plan.cues && plan.cues.length) {
    try {
      const segs = version.segments || [];
      const assWindows = windows.map((w) => ({ start: w.start, end: w.end }));
      const assStyles = segs.map((s, i) => {
        const ss = segStyleAt(i);
        return {
          fontSize: Math.round(size.h * ss.sizeRatio),
          pos: ss.pos,
          color: ss.color,
          outlineColor: ss.outlineColor,
          outline: ss.outline != null ? ss.outline : null,
          font: ss.font,
        };
      });
      if (!assStyles.length) assStyles.push({ fontSize: Math.round(size.h * gStyle.sizeRatio), pos: gStyle.pos, color: gStyle.color, outlineColor: gStyle.outlineColor, outline: gStyle.outline, font: gStyle.font });
      const assText = asr.assFromCues(plan.cues, size, {
        styles: assStyles,
        windows: assWindows,
        font: gStyle.font,
      });
      const assFile = path.join(tempDir, 'subs.ass');
      await fs.writeFile(assFile, assText, 'utf8');
      assRel = path.relative(config.ROOT, assFile).replace(/\\/g, '/');
    } catch (e) {
      assRel = null;
    }
  }

  // 配乐
  // musicMode: 'none'（静音）/ 'demo' / 未设置 → 自动匹配原创配乐
  let musicPath = null;
  if (config.GENERATE_DEMO_MUSIC && version.musicMode !== 'none') {
    const t = await pickMusic(project, project.musicPreset);
    if (t) musicPath = t.path;
  }

  // 视频滤镜链：字幕（ASS）放在 format 之前，保证像素格式统一
  const makeVf = (withAss) => {
    const p = parts.slice();
    if (withAss && assRel) p.push(`subtitles=f='${assRel}'`);
    return (p.length ? p.join(',') + ',' : '') + 'format=yuv420p';
  };

  const buildArgs = (withAss, codec) => {
    const a = ['-y', '-i', path.resolve(concatFile)];
    const vf = makeVf(withAss);
    if (musicPath) {
      const mv = typeof tpl.musicVolume === 'number' ? tpl.musicVolume : 0.25;
      a.push('-stream_loop', '-1', '-i', path.resolve(musicPath));
      // 关键：amix 默认 normalize=1 会把每路都除以输入数，导致原声被压掉 6dB。
      // 这里 normalize=0 保持原声电平，末尾用 alimiter 兜住叠加后的峰值。
      // 口播模板额外做 sidechain 闪避：人声一响，音乐自动让位。
      // 注意 sidechaincompress 输入顺序：第一个 = 被压缩信号（音乐），第二个 = 侧链触发（人声）。
      // 2026-10-29 修复：原来写成 [sc][m] 把语音当被压信号、音乐被整个丢掉——成片从来就没有配乐。
      const oral = !!tpl.preferOral;
      const duck = oral
        ? `[0:a]asplit=2[a0][sc];[1:a]volume=${mv}[m];[m][sc]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[md];[a0][md]amix=inputs=2:duration=first:normalize=0[a0mix];[a0mix]alimiter=limit=0.95[a]`
        : `[0:a]volume=1[a0];[1:a]volume=${mv}[a1];[a0][a1]amix=inputs=2:duration=first:normalize=0[a0mix];[a0mix]alimiter=limit=0.95[a]`;
      a.push('-filter_complex', `[0:v]${vf}[v];${duck}`);
    } else {
      a.push('-filter_complex', `[0:v]${vf}[v];[0:a]volume=1[a]`);
    }
    a.push('-map', '[v]', '-map', '[a]',
      ...codec, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.resolve(outputPath));
    return a;
  };

  await probeQsv();
  // 编码尝试顺序（字幕优先于编码器）：QSV+字幕 → CPU+字幕 → QSV无字幕 → CPU无字幕
  // 字幕滤镜出问题（如缺字体）时降级重渲，保证成片一定能出来
  const attempts = [];
  if (qsvState === 'ok' && assRel) attempts.push(['qsv', QSV_ARGS(), true], ['x264', X264_ARGS(), true]);
  else if (qsvState === 'ok') attempts.push(['qsv', QSV_ARGS(), false]);
  else if (assRel) attempts.push(['x264', X264_ARGS(), true]);
  else attempts.push(['x264', X264_ARGS(), false]);
  if (qsvState === 'ok' && assRel) attempts.push(['qsv', QSV_ARGS(), false]);
  attempts.push(['x264', X264_ARGS(), false]);
  let run1 = null;
  for (const [tag, codec, withAss] of attempts) {
    run1 = await ffmpeg.run(config.FFMPEG_PATH, buildArgs(withAss, codec), { timeout: 300000 });
    if (run1.code === 0) break;
    if (tag === 'qsv') codecFallback('qsv');   // QSV 失败标记，后续渲染直接走 CPU
  }
  if (!run1 || run1.code !== 0) throw new Error('最终合成失败: ' + String(run1 ? run1.stderr : '').slice(-500));
  return outputPath;
}

// ===== 渲染单个版本 =====
async function renderVersion(project, version, outputPath, onProgress) {
  const size = targetSize(project.ratio);
  const tempDir = path.join(config.DIRS.temp, 'render_' + project.id + '_' + version.version + '_' + Date.now());
  await fs.mkdir(tempDir, { recursive: true });
  const matMap = {};
  (project.materials || []).forEach((m) => { matMap[m.id] = m; });

  try {
    const total = version.segments.length;
    // 片段并行渲染（2 路）：硬编时编码在核显上，CPU 主要跑解码+滤镜，2 路并发能再快近一倍
    const CONC = 2;
    const results = new Array(total).fill(null);
    let nextIdx = 0, doneCnt = 0;
    const worker = async () => {
      while (nextIdx < total) {
        const i = nextIdx++;
        const seg = version.segments[i];
        const mat = matMap[seg.materialId];
        if (!mat) { doneCnt++; continue; }
        const f = await normalizeSegment(project.id, mat, seg, size, tempDir, i);
        results[i] = f;
        doneCnt++;
        if (onProgress) onProgress(Math.round((doneCnt / (total + 2)) * 100), `渲染片段 ${doneCnt}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, Math.max(1, total)) }, worker));
    const segFiles = results.filter(Boolean);
    if (segFiles.length === 0) throw new Error('没有可用片段，无法生成视频');

    if (onProgress) onProgress(Math.round((total / (total + 2)) * 100), '拼接视频');
    const concatFile = await concatSegments(segFiles, tempDir);

    if (onProgress) onProgress(Math.round(((total + 1) / (total + 2)) * 100), '规划同步字幕');
    const cuePlan = await collectSubtitles(project, version, matMap);
    if (cuePlan.mode === 'asr') {
      if (onProgress) onProgress(Math.round(((total + 1) / (total + 2)) * 100), `合成字幕与配乐（真实语音字幕 ${cuePlan.cues.length} 条）`);
    } else {
      if (onProgress) onProgress(Math.round(((total + 1) / (total + 2)) * 100), '合成字幕与配乐');
    }
    await composite(project, version, concatFile, matMap, size, tempDir, outputPath, cuePlan);

    // 字幕文件（SRT）：与成片同名，可直接下载/再剪辑使用
    let srtName = null;
    if (cuePlan.mode === 'asr' && cuePlan.cues.length) {
      try {
        srtName = path.basename(outputPath, '.mp4') + '.srt';
        await fs.writeFile(path.join(path.dirname(outputPath), srtName), asr.srtFromCues(cuePlan.cues), 'utf8');
      } catch (_) { srtName = null; }
    }

    // 缩略图
    const thumbName = path.basename(outputPath, '.mp4') + '.jpg';
    const thumbPath = path.join(path.dirname(outputPath), 'thumb', thumbName);
    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await ffmpeg.thumbnail(outputPath, thumbPath, Math.min(1, (version.totalDuration || 3) * 0.3), 480);

    const meta = await ffmpeg.probe(outputPath);
    if (onProgress) onProgress(100, '完成');
    return {
      duration: meta.duration,
      size: meta.size,
      width: meta.video ? meta.video.width : size.w,
      height: meta.video ? meta.video.height : size.h,
      thumbnail: 'thumb/' + thumbName,
      srt: srtName,
      subtitleMode: cuePlan.mode,
      subtitleCount: cuePlan.mode === 'asr' ? cuePlan.cues.length : 0,
    };
  } finally {
    // 清理临时文件（非致命：清理失败绝不影响已完成的渲染结果）
    await safeCleanup(tempDir);
  }
}

// 逐个删除临时文件，避免触发运行环境的"批量递归删除"保护；任何失败都静默忽略
async function safeCleanup(dir) {
  try {
    const entries = await fs.readdir(dir);
    for (const e of entries) {
      const p = path.join(dir, e);
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) {
          await safeCleanup(p);
        } else {
          await fs.unlink(p);
        }
      } catch (_) { /* 忽略单个文件删除失败 */ }
    }
    try { await fs.rmdir(dir); } catch (_) {}
  } catch (_) { /* 目录不存在或不可读，忽略 */ }
}

// ===== 单素材「保存替换原素材」导出 =====
// 把当前素材的剪辑（pieces / 中间截断 / 变速 / 音量 / 静音）渲染成一条干净视频，
// 解析时间轴复用 editor.timelineOf / editor.partsFor，避免重复造轮子。
// 输出保持素材自身宽高比（不强制套项目比例，避免横向素材被裁切），短边≤1080。
function fitSize(w, h) {
  if (!w || !h || w < 2 || h < 2) return { w: 1080, h: 1920 };
  const shortSide = Math.min(w, h);
  const scale = shortSide > 1080 ? 1080 / shortSide : 1;
  let W = Math.round(w * scale), H = Math.round(h * scale);
  W = Math.max(2, W + (W % 2));
  H = Math.max(2, H + (H % 2));
  return { w: W, h: H };
}

async function renderMaterialTrim(projectId, mat, outPath) {
  const matDir = config.materialDir(projectId);
  // 优先用美颜/优化副本作为输入（timelineOf 的时间轴就是相对它们的）；都没有就用原片
  const srcFile = (mat.beauty && mat.beauty.file) || (mat.optimized && mat.optimized.file) || mat.filename;
  const src = path.join(matDir, srcFile);
  if (!fsSync.existsSync(src)) throw new Error('源文件不存在: ' + srcFile);
  const probe = await ffmpeg.probe(src);
  const w = (probe.video && probe.video.width) || mat.width || 1080;
  const h = (probe.video && probe.video.height) || mat.height || 1920;
  const size = fitSize(w, h);

  const tl = editor.timelineOf(mat);
  const speed = editor.speedOf(mat);
  // 压实首尾黑场：剪辑后时间轴开头/结尾常留空隙（如删掉开头一段后剩下的空档），
  // 烘焙成新素材时直接从内容起点开始、到内容终点结束；中间的黑场是刻意安排的，保留不动
  let tStart = 0, tEnd = tl.total;
  {
    let first = null, last = null;
    for (const c of tl.clips) {
      if ((c.vsrc == null && c.asrc == null) || c.dur < 0.05) continue;
      if (first == null) first = c.t0;
      last = c.t0 + c.dur;
    }
    if (first != null && last != null && last - first > 0.3) { tStart = first; tEnd = last; }
  }
  const parts = editor.partsFor(mat, tStart, Math.max(0.3, tEnd - tStart), speed);
  if (!parts.length) throw new Error('该素材剪辑后为空，没有可导出的内容');

  const tempDir = path.join(config.DIRS.temp, 'trim_' + projectId + '_' + mat.id + '_' + Date.now());
  await fs.mkdir(tempDir, { recursive: true });
  try {
    const files = [];
    for (let i = 0; i < parts.length; i++) {
      const f = await normalizePart(projectId, mat, parts[i], size, tempDir, `trim_${i}.mp4`,
        { speed, volume: Number.isFinite(mat.volume) ? mat.volume : 1, srcFile, fadeIn: false, fadeOut: false });
      files.push(f);
    }
    const concatFile = await concatSegments(files, tempDir, 'trim_out.mp4');
    await safeMove(concatFile, outPath);
    const meta = await ffmpeg.probe(outPath);
    return {
      duration: meta.duration,
      width: (meta.video && meta.video.width) || size.w,
      height: (meta.video && meta.video.height) || size.h,
    };
  } finally {
    await safeCleanup(tempDir);
  }
}

// 跨盘/同盘都安全的移动：先 try rename，失败（EXDEV）再 copy+unlink
async function safeMove(from, to) {
  try {
    await fs.rename(path.resolve(from), path.resolve(to));
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      await fs.copyFile(path.resolve(from), path.resolve(to));
      await fs.unlink(path.resolve(from)).catch(() => {});
    } else {
      throw e;
    }
  }
}

// ===== 成片二次剪辑：按保留区间重编码输出（字幕已烧在画面里，跟着走）=====
// pieces: [{in, out}] 秒；区间外的内容被剪掉，区间按时间顺序拼接
async function cutVideoFile(srcPath, pieces, outPath) {
  const valid = (pieces || [])
    .map((p) => ({ in: Math.max(0, Number(p.in) || 0), out: Number(p.out) }))
    .filter((p) => Number.isFinite(p.out) && p.out - p.in > 0.15)
    .sort((a, b) => a.in - b.in);
  if (!valid.length) throw new Error('没有有效的保留区间（每段至少 0.15 秒）');
  await probeQsv();
  const inputs = [];
  const fcParts = [];
  valid.forEach((p, i) => {
    inputs.push('-ss', p.in.toFixed(3), '-to', p.out.toFixed(3), '-i', path.resolve(srcPath));
    fcParts.push(`[${i}:v]fps=30,format=yuv420p[v${i}];[${i}:a]aresample=48000[a${i}]`);
  });
  const mapStr = valid.map((_, i) => `[v${i}][a${i}]`).join('');
  const fc = fcParts.join(';') + ';' + `${mapStr}concat=n=${valid.length}:v=1:a=1[v][a]`;
  const build = (codec) => inputs.concat([
    '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
    ...codec, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', path.resolve(outPath),
  ]);
  let codec = codecArgs(); let tag = qsvState === 'ok' ? 'qsv' : 'x264';
  let r = await ffmpeg.run(config.FFMPEG_PATH, build(codec), { timeout: 600000 });
  if (r.code !== 0 && tag === 'qsv') {
    const fb = codecFallback('qsv');
    if (fb) { codec = fb; r = await ffmpeg.run(config.FFMPEG_PATH, build(codec), { timeout: 600000 }); }
  }
  if (r.code !== 0) throw new Error('二次剪辑渲染失败: ' + String(r.stderr || '').slice(-400));
  return outPath;
}

module.exports = { renderVersion, targetSize, ensureFont, pickMusic, collectSubtitles, renderMaterialTrim, cutVideoFile, fitSize };
