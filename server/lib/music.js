// music.js - 系统原创背景音乐合成器
// 说明：所有波形都在这里用代码实时合成（加性合成 + ADSR 包络 + 一阶低通 + 噪声打击乐），
// 不含任何第三方音频素材，因此无第三方版权；生成结果缓存在 data/music/ 下，只合成一次。
// 与旧版 data/music/demo.m4a（三个正弦长音）的区别：那是占位音，这是可商用原创配乐。

const fs = require('fs/promises');
const path = require('path');
const fsSync = require('fs');
const config = require('../config');
const ffmpeg = require('./ffmpeg');

const SR = 44100;

// ===== 乐理工具 =====
const A4 = 440;
// 半音 → 频率（以 A4 = MIDI 69 为基准）
function freq(midi) { return A4 * Math.pow(2, (midi - 69) / 12); }

// 音名转 MIDI：C4 = 60
const NOTE_OFFSET = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) return 60;
  let v = NOTE_OFFSET[m[1]];
  if (m[2] === '#') v += 1;
  if (m[2] === 'b') v -= 1;
  return v + (parseInt(m[3], 10) + 1) * 12;
}

// ===== 波形与包络 =====
function osc(type, phase) {
  switch (type) {
    case 'saw': return 2 * (phase - Math.floor(phase + 0.5));
    case 'square': return phase - Math.floor(phase) < 0.5 ? 1 : -1;
    case 'tri': return 4 * Math.abs(phase - Math.floor(phase + 0.75) + 0.25) - 1;
    case 'sine':
    default: return Math.sin(2 * Math.PI * phase);
  }
}

// ADSR 包络（秒）
function env(t, dur, a, d, s, r) {
  if (t < 0 || t > dur + r) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t < dur) return s;
  return s * Math.max(0, 1 - (t - dur) / r);
}

// 一阶低通滤波器状态
function lowpass(cut, res) {
  let y = 0;
  const a = Math.exp(-2 * Math.PI * cut / SR);
  return (x) => { y = y * a + x * (1 - a); return y; };
}

// ===== 单个音符渲染 =====
function renderNote(buf, startSec, durSec, midi, opts) {
  const { type = 'sine', gain = 0.2, attack = 0.01, decay = 0.08, sustain = 0.6, release = 0.15,
    cutoff = 6000, detune = 0, pan = 0 } = opts || {};
  const f = freq(midi + detune);
  const start = Math.floor(startSec * SR);
  const total = Math.floor((durSec + release) * SR);
  const lpL = lowpass(cutoff, 0);
  const lpR = lowpass(cutoff, 0);
  const gL = Math.cos((pan + 1) * Math.PI / 4);
  const gR = Math.sin((pan + 1) * Math.PI / 4);
  for (let i = 0; i < total; i++) {
    const idx = start + i;
    if (idx < 0) continue;
    if (idx >= buf.length) break;
    const t = i / SR;
    const e = env(t, durSec, attack, decay, sustain, release);
    if (e <= 0) continue;
    const ph = f * t;
    let s = osc(type, ph);
    // 轻微二次谐波叠加，让音色不那么"电子正弦"
    s = s * 0.85 + osc('sine', ph * 2) * 0.15;
    s = lpL(s) * gL;
    buf[idx] += s * e * gain;
  }
}

// ===== 打击乐 =====
function renderKick(buf, startSec, gain = 0.9) {
  const start = Math.floor(startSec * SR);
  const dur = Math.floor(0.32 * SR);
  let phase = 0;
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) break;
    const t = i / SR;
    const f = 110 * Math.exp(-t * 22) + 42;      // 频率下扫
    phase += f / SR;
    const e = Math.exp(-t * 9);
    buf[idx] += Math.sin(2 * Math.PI * phase) * e * gain;
  }
}
function renderHat(buf, startSec, gain = 0.18, decay = 0.045) {
  const start = Math.floor(startSec * SR);
  const dur = Math.floor(decay * SR);
  let hp = 0, prev = 0;
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) break;
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    hp = 0.85 * (hp + n - prev); // 简易高通，去掉低频留"呲"声
    prev = n;
    buf[idx] += hp * Math.exp(-t * 60) * gain;
  }
}
function renderSnare(buf, startSec, gain = 0.3) {
  const start = Math.floor(startSec * SR);
  const dur = Math.floor(0.18 * SR);
  for (let i = 0; i < dur; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= buf.length) break;
    const t = i / SR;
    const n = (Math.random() * 2 - 1) * Math.exp(-t * 26);
    const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.5;
    buf[idx] += (n * 0.8 + body) * gain;
  }
}

// ===== 风格预设 =====
// progression：每小节一个和弦（根音 + 三和弦音程）
const PRESETS = {
  // 轻快清新：大调、明亮琶音、中等节奏
  fresh: {
    label: '轻快清新 · 商业展示',
    bpm: 112, bars: 8,
    chords: [['C4', [0, 4, 7]], ['G3', [0, 4, 7]], ['A3', [0, 3, 7]], ['F3', [0, 4, 7]]],
    arp: true, arpGain: 0.16, arpWave: 'tri',
    pad: true, padGain: 0.10, padCut: 2200,
    bass: true, bassGain: 0.34, bassWave: 'sine',
    perc: { kick: [0, 2], snare: [], hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], hatGain: 0.13 },
  },
  // 轻奢质感：慢、暖 pad、极少打击乐，适合礼盒/精品包装（16 小节 ≈ 49s，入库需 30~90s）
  luxe: {
    label: '舒缓轻奢 · 礼盒质感',
    bpm: 78, bars: 16,
    chords: [['D4', [0, 3, 7]], ['A3', [0, 4, 7]], ['B3', [0, 3, 7]], ['G3', [0, 4, 7]]],
    arp: true, arpGain: 0.10, arpWave: 'sine',
    pad: true, padGain: 0.16, padCut: 1500,
    bass: true, bassGain: 0.24, bassWave: 'sine',
    perc: { kick: [0], snare: [], hat: [1, 3], hatGain: 0.05 },
  },
  // 快节奏电商：驱动感强
  punch: {
    label: '快节奏 · 电商爆款',
    bpm: 128, bars: 8,
    chords: [['A3', [0, 3, 7]], ['F3', [0, 4, 7]], ['C4', [0, 4, 7]], ['G3', [0, 4, 7]]],
    arp: true, arpGain: 0.18, arpWave: 'saw',
    pad: false, padGain: 0, padCut: 1800,
    bass: true, bassGain: 0.40, bassWave: 'square',
    perc: { kick: [0, 1.5, 2, 3.5], snare: [1, 3], hat: [0.5, 1, 1.5, 2, 2.5, 3, 3.5], hatGain: 0.16 },
  },
  // 口播背景：极简，不抢人声（16 小节 ≈ 42s，入库需 30~90s）
  speech: {
    label: '轻柔背景 · 口播不抢声',
    bpm: 92, bars: 16,
    chords: [['F3', [0, 4, 7]], ['C4', [0, 4, 7]], ['G3', [0, 4, 7]], ['A3', [0, 3, 7]]],
    arp: true, arpGain: 0.07, arpWave: 'sine',
    pad: true, padGain: 0.13, padCut: 1200,
    bass: false, bassGain: 0, bassWave: 'sine',
    perc: { kick: [], snare: [], hat: [1, 3], hatGain: 0.035 },
  },
  // —— 产品口播讲解类专用（纯音乐 · 中速 · 情绪中性偏积极 · 可循环 · 30~60s）——
  // 轻钢琴：快起音 + 长衰减 + 低延音，模拟钢琴拨奏质感
  piano: {
    label: '轻钢琴 · 产品口播',
    bpm: 84, bars: 16,
    chords: [['C4', [0, 4, 7]], ['G3', [0, 4, 7]], ['A3', [0, 3, 7]], ['F3', [0, 4, 7]],
             ['C4', [0, 4, 7]], ['G3', [0, 4, 7]], ['F3', [0, 4, 7]], ['G3', [0, 4, 7]]],
    arp: true, arpGain: 0.13, arpWave: 'sine',
    arpEnv: { attack: 0.004, decay: 0.55, sustain: 0.06, release: 0.5 },
    arpCut: 3600,
    pad: true, padGain: 0.09, padCut: 1400,
    bass: true, bassGain: 0.20, bassWave: 'sine',
    perc: { kick: [0], snare: [], hat: [1, 3], hatGain: 0.03 },
  },
  // 氛围合成器：长气息铺底为主，干净透气，适合功能演示/工具讲解
  ambient: {
    label: '氛围合成器 · 功能演示',
    bpm: 96, bars: 16,
    chords: [['A3', [0, 3, 7]], ['F3', [0, 4, 7]], ['C4', [0, 4, 7]], ['G3', [0, 4, 7]]],
    arp: true, arpGain: 0.08, arpWave: 'tri',
    pad: true, padGain: 0.15, padCut: 1700,
    bass: true, bassGain: 0.22, bassWave: 'sine',
    perc: { kick: [0, 2], snare: [], hat: [1, 3], hatGain: 0.05 },
  },
  // 轻柔吉他：三角波短音快衰减，模拟拨弦
  guitar: {
    label: '轻柔吉他 · 好物讲解',
    bpm: 100, bars: 16,
    chords: [['G3', [0, 4, 7]], ['D4', [0, 4, 7]], ['B3', [0, 3, 7]], ['C4', [0, 4, 7]]],
    arp: true, arpGain: 0.14, arpWave: 'tri',
    arpEnv: { attack: 0.003, decay: 0.28, sustain: 0.08, release: 0.22 },
    arpCut: 4200,
    pad: true, padGain: 0.07, padCut: 1300,
    bass: true, bassGain: 0.24, bassWave: 'sine',
    perc: { kick: [0], snare: [], hat: [0.5, 1.5, 2.5, 3.5], hatGain: 0.05 },
  },
  // 轻打击乐：节奏平稳有律动，但整体音量克制
  groove: {
    label: '轻打击乐 · 节奏平稳',
    bpm: 104, bars: 24,
    chords: [['C4', [0, 4, 7]], ['A3', [0, 3, 7]], ['F3', [0, 4, 7]], ['G3', [0, 4, 7]]],
    arp: true, arpGain: 0.09, arpWave: 'sine',
    pad: true, padGain: 0.08, padCut: 1500,
    bass: true, bassGain: 0.26, bassWave: 'sine',
    perc: { kick: [0, 2], snare: [], hat: [0.5, 1, 1.5, 2, 2.5, 3, 3.5], hatGain: 0.06 },
  },
};

// ===== 合成一条循环 =====
function synthesize(presetKey) {
  const p = PRESETS[presetKey];
  const beat = 60 / p.bpm;
  const bar = beat * 4;
  const total = bar * p.bars;
  const n = Math.floor(total * SR);
  const buf = new Float32Array(n);

  for (let b = 0; b < p.bars; b++) {
    const barStart = b * bar;
    const [rootName, intervals] = p.chords[b % p.chords.length];
    const root = midiOf(rootName);

    // 低音：每拍一下，落在根音上
    if (p.bass) {
      for (let k = 0; k < 4; k++) {
        const oct = k === 0 ? 0 : (k === 2 ? 0 : -0); // 同八度内走，保持稳定
        renderNote(buf, barStart + k * beat, beat * 0.55, root - 24 + oct, {
          type: p.bassWave, gain: p.bassGain, attack: 0.005, decay: 0.12, sustain: 0.5, release: 0.12, cutoff: 900,
        });
      }
    }

    // 铺底和弦：整小节长音
    if (p.pad) {
      for (const iv of intervals) {
        renderNote(buf, barStart, bar * 0.95, root + iv, {
          type: 'saw', gain: p.padGain / intervals.length, attack: 0.25, decay: 0.3, sustain: 0.75, release: 0.5, cutoff: p.padCut, pan: -0.2,
        });
        renderNote(buf, barStart, bar * 0.95, root + iv + 12, {
          type: 'saw', gain: p.padGain / intervals.length * 0.6, attack: 0.3, decay: 0.3, sustain: 0.7, release: 0.5, cutoff: p.padCut, pan: 0.2,
        });
      }
    }

    // 琶音：八分音符走和弦音（预设可用 arpEnv/arpCut 自定义音色包络）
    if (p.arp) {
      const tones = [intervals[0], intervals[1], intervals[2], intervals[1] + 12];
      const ae = p.arpEnv || { attack: 0.005, decay: 0.09, sustain: 0.35, release: 0.1 };
      for (let k = 0; k < 8; k++) {
        const iv = tones[k % tones.length];
        renderNote(buf, barStart + k * (beat / 2), beat * 0.4, root + 12 + iv, {
          type: p.arpWave, gain: p.arpGain,
          attack: ae.attack, decay: ae.decay, sustain: ae.sustain, release: ae.release,
          cutoff: p.arpCut || 5200, pan: (k % 2 === 0 ? -0.35 : 0.35),
        });
      }
    }

    // 打击乐
    const pc = p.perc || {};
    for (const t of (pc.kick || [])) renderKick(buf, barStart + t * beat, 0.85);
    for (const t of (pc.snare || [])) renderSnare(buf, barStart + t * beat, 0.28);
    for (const t of (pc.hat || [])) renderHat(buf, barStart + t * beat, pc.hatGain || 0.12);
  }

  // 收尾：软限幅 + 归一化到 -1.5 dBFS；首尾各留 8ms 静音，保证循环点无爆音
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[i];
    buf[i] = Math.tanh(v * 1.1); // 软削波，避免数字过载
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  const target = Math.pow(10, -1.5 / 20); // -1.5 dBFS
  const g = peak > 0 ? target / peak : 1;
  for (let i = 0; i < n; i++) buf[i] *= g;
  const fade = Math.floor(0.008 * SR);
  for (let i = 0; i < fade && i < n; i++) { buf[i] *= i / fade; buf[n - 1 - i] *= i / fade; }

  return { samples: buf, duration: total, label: p.label };
}

// ===== 编码落盘（只生成一次，之后复用缓存）=====
async function ensureTrack(presetKey) {
  const p = PRESETS[presetKey];
  if (!p) throw new Error('未知音乐风格：' + presetKey);
  const out = path.join(config.DIRS.music, presetKey + '.m4a');
  if (fsSync.existsSync(out)) return { path: out, label: p.label, key: presetKey };
  await fs.mkdir(config.DIRS.music, { recursive: true });

  const { samples } = synthesize(presetKey);
  const pcm = path.join(config.DIRS.temp, `pcm_${presetKey}.raw`);
  // Float32 → Int16 PCM
  const i16 = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    i16.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  await fs.writeFile(pcm, i16);

  const { code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, [
    '-y', '-f', 's16le', '-ar', String(SR), '-ac', '1', '-i', path.resolve(pcm),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    path.resolve(out),
  ], { timeout: 180000 });
  try { await fs.unlink(pcm); } catch (_) {}
  if (code !== 0) throw new Error('音乐编码失败: ' + String(stderr || '').slice(-200));
  return { path: out, label: p.label, key: presetKey };
}

// ===== 按项目/模板挑选风格 =====
// 规则：口播模板一律用 speech（人声优先）；礼盒/邀请函类走 luxe；其余按类别与节奏选
function pickPreset(project) {
  const style = String(project.style || '');
  if (/口播/.test(style)) return 'speech';
  const cat = String(project.category || '');
  if (['礼品盒', '邀请函'].includes(cat)) return 'luxe';
  if (/快节奏/.test(style)) return 'punch';
  return 'fresh';
}

function listPresets() {
  return Object.keys(PRESETS).map((k) => ({ key: k, label: PRESETS[k].label, bpm: PRESETS[k].bpm }));
}

module.exports = { PRESETS, synthesize, ensureTrack, pickPreset, listPresets };
