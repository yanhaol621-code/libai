// asr.js - 本机离线语音识别（faster-whisper），用于口播同步字幕 / SRT / 重复口播检测
// 原则：
// 1. 完全离线：本机 Python + 本机模型目录，无任何外网调用；环境缺失时明确报「不可用」，不伪造字幕。
// 2. 真实时间戳：字幕时间来自模型的词级时间轴，不做等分切分、不做固定字幕。
// 3. 缓存：结果落盘 materials/asr/<素材id>.json，重复调用不重复计算。

const { spawn } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const SCRIPT = path.join(config.ROOT, 'scripts', 'asr.py');
const MODEL_ROOT = path.join(config.ROOT, 'models');
// SenseVoice 的分词器由 sentencepiece（C++）加载，在 Windows 上无法打开含中文的
// 路径（如 D:/混剪网站/...）。用无中文的目录联结 D:/mxsite -> D:/混剪网站 规避。
const ASCII_ROOT = process.env.ASR_ASCII_ROOT || 'D:/mxsite';

// ===== 环境解析 =====
function resolvePython() {
  const cands = [];
  if (process.env.PYTHON_PATH) cands.push(process.env.PYTHON_PATH);
  cands.push('C:/Users/Administrator/.workbuddy/binaries/python/versions/3.13.12/python.exe');
  cands.push(path.join(config.ROOT, '.venv', 'Scripts', 'python.exe'));
  cands.push('python');
  cands.push('python3');
  for (const c of cands) {
    try {
      if (c === 'python' || c === 'python3') {
        // PATH 里的 python：用同步探测代价高，这里乐观返回，调用失败会报错
        return c;
      }
      if (fsSync.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return 'python';
}

// 目录是否含模型权重文件（FunASR / whisper 通用签名）
function hasModelFiles(dir) {
  if (!dir || !fsSync.existsSync(dir)) return false;
  try {
    for (const f of fsSync.readdirSync(dir)) {
      const lower = f.toLowerCase();
      if (/^(pytorch_model\.bin|model\.pt|model\.bin|configuration\.json)$/.test(lower)) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function dirSizeMB(dir) {
  let total = 0;
  try {
    const walk = (p) => {
      for (const e of fsSync.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp);
        else total += fsSync.statSync(fp).size;
      }
    };
    walk(dir);
  } catch (_) { /* ignore */ }
  return Math.round(total / 1048576);
}

// FunASR 模型就绪：主模型目录有权重 + 相邻 fsmn-vad 就绪（paraformer 还需 punc）
function funasrReady(modelDir, backend) {
  if (!hasModelFiles(modelDir)) return false;
  const vadDir = path.join(modelDir, '..', 'fsmn-vad');
  if (!hasModelFiles(vadDir)) return false;
  if (backend === 'paraformer') {
    const puncDir = path.join(modelDir, '..', 'punc-ct-transformer');
    if (!hasModelFiles(puncDir)) return false;
  }
  return true;
}

function listModels() {
  const out = [];
  try {
    if (!fsSync.existsSync(MODEL_ROOT)) return out;
    for (const d of fsSync.readdirSync(MODEL_ROOT)) {
      const dir = path.join(MODEL_ROOT, d);
      let st;
      try { st = fsSync.statSync(dir); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      let backend, label, ready, sizeMB = dirSizeMB(dir);
      if (/^whisper-/.test(d)) {
        backend = 'whisper';
        label = d.replace(/^whisper-/, '');
        const bin = path.join(dir, 'model.bin');
        const tok = path.join(dir, 'tokenizer.json');
        ready = fsSync.existsSync(bin) && fsSync.existsSync(tok);
        if (fsSync.existsSync(bin)) sizeMB = Math.round(fsSync.statSync(bin).size / 1048576);
      } else if (/^paraformer/.test(d)) {
        backend = 'paraformer';
        label = 'paraformer-large';
        ready = funasrReady(dir, 'paraformer');
      } else if (/^sensevoice/.test(d)) {
        backend = 'sensevoice';
        label = 'sensevoice-small';
        // 走无中文联结路径做就绪/体积检查
        dir = path.join(ASCII_ROOT, 'models', d);
        ready = funasrReady(dir, 'sensevoice');
      } else {
        continue; // fsmn-vad / punc-ct-transformer 等是依赖，不作为可选模型
      }
      out.push({ key: d, label, backend, ready, sizeMB });
    }
  } catch (_) { /* ignore */ }
  const prio = { paraformer: 0, sensevoice: 1, whisper: 2 };
  return out.sort((a, b) => (prio[a.backend] - prio[b.backend]) || a.label.localeCompare(b.label));
}

// 默认模型优先级：中文场景优选 FunASR（paraformer 最准、sensevoice 最稳最快）
function defaultModelKey() {
  const models = listModels().filter((m) => m.ready);
  if (!models.length) return null;
  // 精度优先：medium > small > base > tiny
  const order = ['paraformer-large', 'sensevoice-small', 'medium', 'small', 'base', 'tiny'];
  models.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  return models[0].key;
}

function defaultLabel() {
  const k = defaultModelKey();
  if (!k) return null;
  const m = listModels().find((x) => x.key === k);
  return m ? m.label : null;
}

function modelDir(key) {
  // SenseVoice 走无中文联结路径，规避 sentencepiece 在 Windows 上对中文路径的打开失败
  if (key && /^sensevoice/.test(key)) return path.join(ASCII_ROOT, 'models', key);
  return path.join(MODEL_ROOT, key || '');
}

// ===== 预热 =====
// 主动把常驻进程拉起来。冷启动真正慢的不是推理（一条 10s 素材 0.4~1.3s），而是
// python 导入 torch/funasr（~14s）+ 加载 1.1GB punc 权重（~6s）。这些开销只该在
// 服务启动 / 打开项目页时发生，不该让运营点「开始识别」后再等。
// 所以要换的模型和当前常驻的不一样时不硬切（会把正在跑的识别打断），直接放弃。
function backendOf(model) {
  return /^paraformer/.test(model || '') ? 'paraformer'
    : /^sensevoice/.test(model || '') ? 'sensevoice'
    : 'whisper';
}

function warmState() {
  return {
    ready: !!(warm && warm.ready),
    loading: !!(warmStart && !(warm && warm.ready)),
    busy: !!(warm && warm.cur),
    model: (warm && warm.key) || warmStartKey || null,
  };
}

function prewarm({ model } = {}) {
  const key = model || defaultModelKey();
  if (!key) return false;
  const bk = backendOf(key);
  if (bk === 'whisper') return false;            // whisper 只有一次性进程，无常驻可预热
  const st = warmState();
  const freeMB = os.freemem() / 1048576;
  if (st.ready && st.model === key) {
    // 内存吃紧时不再续命，让空闲回收把 2.5GB 还给美颜/混剪
    if (freeMB >= 2048 && warm) resetIdle(warm);
    return true;
  }
  if (st.loading && st.model === key) return false;
  if (st.busy) return false;                     // 有识别在跑，别把进程切掉
  if (freeMB < PREWARM_MIN_FREE_MB) {
    console.warn('[asr] 内存余量 %dMB < %dMB，暂不预热（点识别时会按需加载）', Math.round(freeMB), PREWARM_MIN_FREE_MB);
    return false;
  }
  ensureWarm(bk, key)
    .then(() => console.log('[asr] prewarmed %s', key))
    .catch((e) => console.warn('[asr] prewarm failed:', e.message));
  return false;
}

function status() {
  const python = resolvePython();
  const models = listModels();
  const ready = models.filter((m) => m.ready);
  return {
    ready: !!SCRIPT && fsSync.existsSync(SCRIPT) && ready.length > 0,
    python,
    script: SCRIPT,
    scriptReady: fsSync.existsSync(SCRIPT),
    modelRoot: MODEL_ROOT,
    models,
    defaultModel: defaultModelKey(),
    defaultLabel: defaultLabel(),
    warm: warmState(),
  };
}

// ===== 调用 Python 识别 =====
// 返回 Promise<result>；onProgress(0~1)
function runASR(inputFile, { model, lang = 'zh', prompt = '', beam = 5, backend, onProgress, timeout = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    const key = model || defaultModelKey();
    // 后端由模型目录名决定（whisper-*/paraformer*/sensevoice*）
    const bk = backend
      || (/^paraformer/.test(key || '') ? 'paraformer'
        : /^sensevoice/.test(key || '') ? 'sensevoice'
        : 'whisper');
    const outFile = path.join(config.DIRS.temp, `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    const args = [
      SCRIPT,
      '--input', path.resolve(inputFile),
      '--model', path.resolve(modelDir(key)),
      '--out', path.resolve(outFile),
      '--backend', bk,
      '--ffmpeg', config.FFMPEG_PATH,
      '--lang', lang || 'zh',
      '--beam', String(beam),
    ];
    if (prompt) args.push('--prompt', String(prompt).slice(0, 400));
    const ps = spawn(resolvePython(), args, { windowsHide: true, cwd: config.ROOT });
    let stdout = '';
    let stderr = '';
    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) {
        const m = /PROGRESS ([0-9.]+)/.exec(s);
        if (m) onProgress(parseFloat(m[1]));
      }
    });
    const kill = setTimeout(() => { try { ps.kill('SIGKILL'); } catch (_) {} }, timeout);
    ps.on('error', (e) => { clearTimeout(kill); reject(new Error('无法启动 Python：' + e.message)); });
    ps.on('close', async (code) => {
      clearTimeout(kill);
      const line = stdout.trim().split('\n').pop();
      let info = null;
      try { info = JSON.parse(line || '{}'); } catch (_) { info = null; }
      if (code !== 0 || !info || !info.ok) {
        const msg = (info && info.error) || stderr.trim().split('\n').slice(-3).join(' ').slice(-400) || ('退出码 ' + code);
        try { await fs.unlink(outFile); } catch (_) {}
        return reject(new Error('语音识别失败：' + msg));
      }
      try {
        const raw = await fs.readFile(outFile, 'utf8');
        const result = JSON.parse(raw);
        try { await fs.unlink(outFile); } catch (_) {}
        resolve(result);
      } catch (e) {
        reject(new Error('读取识别结果失败：' + e.message));
      }
    });
  });
}

// ===== 素材级识别（带落盘缓存）=====
function asrDir(projectId) {
  return path.join(config.materialDir(projectId), 'asr');
}

// ===== 批量识别：多个文件一次 spawn，模型只加载一次 =====
// （实测：模型加载 ~35s，单个 10s 素材推理 ~0.5s；逐条 spawn 时加载开销被重复 N 次）
// 返回 Promise<result[]>，与 inputFiles 顺序一一对应。

// ===== 常驻识别进程（warm worker）=====
// 模型加载一次常驻内存，后续识别请求走 stdin 协议（asr.py --serve），跳过全部加载开销。
// 空闲 30 分钟自动回收（原来 5 分钟，实测运营来回切页面很容易让进程被回收，
// 下次点识别又要重新吃 20 多秒的 python 导入 + 权重加载）；进程崩溃/换模型自动降级回
// 一次性进程（runASRBatchOneShot）。服务启动和打开项目页时会主动预热（prewarm）。
const WARM_IDLE_MS = Number(process.env.ASR_WARM_IDLE_MS || 20 * 60 * 1000);
// 常驻进程实测吃 2.5GB 左右（paraformer + 1.1GB punc 权重）。机器内存不够时不预热，
// 免得把美颜/混剪的余量挤没；点识别时照常按需加载，只是那一次要等。
const PREWARM_MIN_FREE_MB = Number(process.env.ASR_PREWARM_MIN_FREE_MB || 5120);
let warm = null;        // { ps, key, bk, ready, chain, stdoutBuf, cur, idleTimer }
let warmStart = null;   // 启动中的 Promise
let warmStartReject = null;  // 启动中 Promise 的 reject：进程没 ready 就退出时必须唤醒等待方
let warmStartKey = null;
let warmSeq = 0;

function killWarm(reason) {
  warmStart = null;
  // 还没 ready 就死掉的常驻进程：把等它的请求叫醒，让上层降级到一次性进程，
  // 否则 await ensureWarm() 永远不返回，界面会一直停在「模型加载中 / 0%」
  if (warmStartReject) {
    const rej = warmStartReject;
    warmStartReject = null;
    try { rej(new Error('识别进程已退出（' + (reason || '未知') + '）')); } catch (_) {}
  }
  if (!warm) return;
  const w = warm;
  warm = null;
  if (w.idleTimer) clearTimeout(w.idleTimer);
  try { w.ps.kill(); } catch (_) {}
  if (w.cur && w.cur.reject) {
    clearTimeout(w.cur.timer);
    w.cur.reject(new Error('识别进程已退出（' + (reason || '未知') + '），请重试'));
  }
}

function resetIdle(w) {
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => killWarm('idle'), WARM_IDLE_MS);
}

function ensureWarm(bk, key) {
  if (warm && warm.ready && warm.key === key && !warm.ps.killed) {
    resetIdle(warm);            // 有请求进来就续命，避免跑到一半被空闲回收
    return Promise.resolve(warm);
  }
  if (warmStart && warmStartKey === key) return warmStart;
  killWarm('restart');
  warmStartKey = key;
  warmStart = new Promise((resolve, reject) => {
    warmStartReject = reject;
    const args = [
      SCRIPT, '--serve',
      '--model', path.resolve(modelDir(key)),
      '--backend', bk,
      '--ffmpeg', config.FFMPEG_PATH,
    ];
    const ps = spawn(resolvePython(), args, { windowsHide: true, cwd: config.ROOT });
    const w = warm = { ps, key, bk, ready: false, chain: Promise.resolve(), stdoutBuf: '', cur: null, idleTimer: null };
    ps.stdout.on('data', (d) => {
      if (warm !== w) return;
      w.stdoutBuf += d.toString();
      let idx;
      while ((idx = w.stdoutBuf.indexOf('\n')) >= 0) {
        const line = w.stdoutBuf.slice(0, idx).trim();
        w.stdoutBuf = w.stdoutBuf.slice(idx + 1);
        if (!line.startsWith('RESULT ')) continue;
        let msg = null;
        try { msg = JSON.parse(line.slice(7)); } catch (_) { continue; }
        const cur = w.cur;
        if (cur && msg.id === cur.id) {
          w.cur = null;
          finishWarmRequest(w, cur, msg);
        }
      }
    });
    ps.stderr.on('data', (d) => {
      if (warm !== w) return;
      const s = d.toString();
      if (!w.ready && /WORKER_READY|MODEL_READY/.test(s)) {
        w.ready = true;
        warmStart = null;
        warmStartReject = null;
        resetIdle(w);
        console.log('[asr] warm worker ready (model=%s, backend=%s)', key, bk);
        resolve(w);
      }
      const cur = w.cur;
      if (!cur) return;
      const fm = /FILE (\d+) (\d+)/.exec(s);
      if (fm) {
        cur.curFile = parseInt(fm[1], 10);
        if (cur.onFile) cur.onFile(cur.curFile, cur.files.length, cur.files[cur.curFile]);
      }
      if (cur.onProgress) {
        const m = /PROGRESS ([0-9.]+)/.exec(s);
        if (m) {
          const frac = Math.max(0, Math.min(1, parseFloat(m[1])));
          const overall = cur.files.length > 1
            ? Math.min(0.99, (cur.curFile + frac) / cur.files.length)
            : frac;
          cur.onProgress(overall);
        }
      }
    });
    ps.on('error', (e) => {
      if (warm === w) { warm = null; }
      warmStart = null;
      warmStartReject = null;
      reject(new Error('无法启动 Python：' + e.message));
    });
    ps.on('close', (code) => {
      if (!w.ready) {
        // 启动阶段就退出（模型损坏 / 依赖缺失 / 被系统杀掉）：明确失败，交给上层降级
        if (warm === w) warm = null;
        warmStart = null;
        warmStartReject = null;
        reject(new Error('识别模型进程启动失败（退出码 ' + code + '）'));
        return;
      }
      if (warm === w) killWarm('exit');
    });
  });
  warmStart.catch(() => {});
  return warmStart;
}

function finishWarmRequest(w, entry, msg) {
  clearTimeout(entry.timer);
  resetIdle(w);
  (async () => {
    if (msg.ok === false) {
      try { await fs.unlink(msg.out); } catch (_) {}
      return entry.reject(new Error('语音识别失败：' + (msg.error || '未知错误')));
    }
    try {
      const raw = await fs.readFile(msg.out, 'utf8');
      const data = JSON.parse(raw);
      try { await fs.unlink(msg.out); } catch (_) {}
      if (data.batch && Array.isArray(data.results)) return entry.resolve(data.results);
      if (Array.isArray(data)) return entry.resolve(data);
      entry.resolve([data]);
    } catch (e) {
      entry.reject(new Error('读取识别结果失败：' + e.message));
    }
  })();
}

function warmRun(w, files, opts) {
  if (w.idleTimer) { clearTimeout(w.idleTimer); w.idleTimer = null; }  // 干活期间不回收
  const exec = () => new Promise((resolve, reject) => {
    const id = ++warmSeq;
    const outFile = path.join(config.DIRS.temp, `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    const entry = {
      id, files, onFile: opts.onFile, onProgress: opts.onProgress, curFile: 0, resolve, reject,
      timer: setTimeout(() => {
        if (w.cur === entry) w.cur = null;
        killWarm('timeout');
        reject(new Error('语音识别超时'));
      }, opts.timeout || 3600000),
    };
    w.cur = entry;
    const req = { id, inputs: files.map((f) => path.resolve(f)), out: path.resolve(outFile) };
    w.ps.stdin.write(JSON.stringify(req) + '\n');
  });
  const p = w.chain.then(exec, exec);
  w.chain = p.catch(() => {});
  return p;
}

// 一次性进程路径（原 runASRBatch 逻辑，作为 warm worker 不可用时的兜底）
function runASRBatchOneShot(inputFiles, { model, lang = 'zh', prompt = '', beam = 5, backend, onProgress, onFile, timeout = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const files = (inputFiles || []).filter(Boolean);
    if (!files.length) return reject(new Error('没有需要识别的文件'));
    const outFile = path.join(config.DIRS.temp, `asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
    const args = [
      SCRIPT,
      '--model', path.resolve(modelDir(model || defaultModelKey())),
      '--out', path.resolve(outFile),
      '--backend', backend,
      '--ffmpeg', config.FFMPEG_PATH,
      '--lang', lang || 'zh',
      '--beam', String(beam),
    ];
    for (const f of files) args.push('--input', path.resolve(f));
    if (prompt) args.push('--prompt', String(prompt).slice(0, 400));
    const ps = spawn(resolvePython(), args, { windowsHide: true, cwd: config.ROOT });
    let stdout = '';
    let stderr = '';
    let curFile = -1;
    ps.stdout.on('data', (d) => { stdout += d.toString(); });
    ps.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      const fm = /FILE (\d+) (\d+)/.exec(s);
      if (fm) {
        curFile = parseInt(fm[1], 10);
        if (onFile) onFile(curFile, files.length, files[curFile]);
      }
      if (onProgress) {
        const m = /PROGRESS ([0-9.]+)/.exec(s);
        if (m) {
          // 单文件内进度 0~1，折算为整体进度 (cur+frac)/n
          const frac = Math.max(0, Math.min(1, parseFloat(m[1])));
          const overall = files.length > 1
            ? Math.min(0.99, (Math.max(curFile, 0) + frac) / files.length)
            : frac;
          onProgress(overall);
        }
      }
    });
    const kill = setTimeout(() => { try { ps.kill('SIGKILL'); } catch (_) {} }, timeout);
    ps.on('error', (e) => { clearTimeout(kill); reject(new Error('无法启动 Python：' + e.message)); });
    ps.on('close', async (code) => {
      clearTimeout(kill);
      const line = stdout.trim().split('\n').pop();
      let info = null;
      try { info = JSON.parse(line || '{}'); } catch (_) { info = null; }
      if (code !== 0 || !info || !info.ok) {
        const msg = (info && info.error) || stderr.trim().split('\n').slice(-3).join(' ').slice(-400) || ('退出码 ' + code);
        try { await fs.unlink(outFile); } catch (_) {}
        return reject(new Error('语音识别失败：' + msg));
      }
      try {
        const raw = await fs.readFile(outFile, 'utf8');
        const data = JSON.parse(raw);
        try { await fs.unlink(outFile); } catch (_) {}
        if (data.batch && Array.isArray(data.results)) return resolve(data.results);
        // 单文件：包装成数组保持一致
        if (!Array.isArray(data)) return resolve([data]);
        resolve(data);
      } catch (e) {
        reject(new Error('读取识别结果失败：' + e.message));
      }
    });
  });
}

function runASRBatch(inputFiles, { model, lang = 'zh', prompt = '', beam = 5, backend, onProgress, onFile, timeout = 3600000 } = {}) {
  const files = (inputFiles || []).filter(Boolean);
  if (!files.length) return Promise.reject(new Error('没有需要识别的文件'));
  const key = model || defaultModelKey();
  const bk = backend
    || (/^paraformer/.test(key || '') ? 'paraformer'
      : /^sensevoice/.test(key || '') ? 'sensevoice'
      : 'whisper');
  // 常驻进程用于 FunASR 中文后端（prompt 仅 whisper 解码器使用，FunASR 不参与推理）；
  // whisper 后端与带提示词的 whisper 请求走一次性进程
  if (bk === 'whisper') {
    return runASRBatchOneShot(files, { model: key, lang, prompt, beam, backend: bk, onProgress, onFile, timeout });
  }
  return ensureWarm(bk, key)
    .then((w) => warmRun(w, files, { onFile, onProgress, timeout }))
    .catch((e) => {
      console.warn('[asr] warm worker unavailable, fallback to one-shot:', e.message);
      return runASRBatchOneShot(files, { model: key, lang, prompt, beam, backend: bk, onProgress, onFile, timeout });
    });
}

async function readResult(projectId, mat) {
  if (!mat || !mat.asr || !mat.asr.file) return null;
  const p = path.join(config.materialDir(projectId), mat.asr.file);
  try {
    const raw = await fs.readFile(p, 'utf8');
    return sanitize(JSON.parse(raw));
  } catch (_) { return null; }
}

// ===== 幻觉过滤 =====
// Whisper 遇到纯音乐/环境音时会"编"出歌词式的假字幕。宁可不上字幕，也不能上假字幕。
// 判定依据全部是模型自身输出的可信度指标（实测：真人口播 nsp≤0.11 / logprob≥-0.24；
// 纯 BGM 幻觉 nsp≈0.43 / logprob≈-0.38）。
const NSP_MAX = 0.30;      // no_speech_prob 超过即判为非语音
const LOGP_MIN = -0.35;    // 平均对数概率过低 = 模型自己也不确定
const CR_MAX = 2.6;        // 压缩比过高 = 在循环重复（典型幻觉）

function sanitize(result) {
  if (!result || !Array.isArray(result.segments)) return result;
  const kept = [];
  let dropped = 0;
  for (const s of result.segments) {
    const nsp = Number(s.no_speech_prob);
    const lp = Number(s.avg_logprob);
    const cr = Number(s.compression_ratio);
    const bad = (Number.isFinite(nsp) && nsp >= NSP_MAX)
      || (Number.isFinite(lp) && lp <= LOGP_MIN)
      || (Number.isFinite(cr) && cr >= CR_MAX);
    if (bad) { dropped++; continue; }
    kept.push(s);
  }
  // 旧版本结果里没有可信度指标，无法判断是否幻听 → 标记出来，要求重新识别
  const legacy = kept.length > 0 && !kept.some((s) => typeof s.no_speech_prob === 'number');
  return Object.assign({}, result, {
    segments: kept,
    droppedSegments: dropped,
    legacy,
    text: kept.map((s) => s.text || '').join(''),
  });
}

// 过滤后还剩多少真的人声
function hasSpeech(result) {
  const segs = (result && result.segments) || [];
  if (!segs.length) return false;
  if (result.legacy) return false; // 没有可信度指标，一律按"不可用于上字幕"处理
  let speech = 0;
  for (const s of segs) speech += Math.max(0, (s.end || 0) - (s.start || 0));
  const dur = result.duration || 0;
  return speech >= 1.5 && (!dur || speech / dur >= 0.1);
}

// 识别单个素材：结果写入 materials/asr/<id>.json，素材上只留摘要
async function transcribeMaterial(projectId, mat, opts = {}) {
  if (!mat || mat.type !== 'video') throw new Error('只有视频素材可以做语音识别');
  const src = path.join(config.materialDir(projectId), mat.filename);
  if (!fsSync.existsSync(src)) throw new Error('素材文件不存在');
  const dir = asrDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const result = await runASR(src, {
    model: opts.model,
    lang: opts.lang || 'zh',
    prompt: opts.prompt || '',
    onProgress: opts.onProgress,
  });
  const clean = sanitize(result);
  const speech = speechStats(clean);
  const voiced = hasSpeech(clean);
  const cues = voiced ? cuesFromResult(clean, opts) : [];
  const repeats = voiced ? findRepeats(clean) : { count: 0, items: [] };
  const rel = 'asr/' + mat.id + '.json';
  await fs.writeFile(path.join(dir, mat.id + '.json'), JSON.stringify(result), 'utf8');
  return {
    summary: {
      file: rel,
      engine: result.engine || 'faster-whisper',
      model: result.model,
      language: result.language,
      languageProbability: result.languageProbability,
      duration: result.duration,
      cueCount: cues.length,
      chars: (clean.text || '').replace(/\s/g, '').length,
      text: (clean.text || '').slice(0, 300),
      repeatCount: repeats.items.length,
      speech,
      // 没有人声就不生成字幕（避免把 BGM 幻听成字幕压进成片）
      speechless: !voiced,
      legacy: !!clean.legacy,
      droppedSegments: clean.droppedSegments || 0,
      at: new Date().toISOString(),
    },
    cues,
    repeats,
    result,
  };
}

// ===== 批量素材识别：一次加载模型，识别全部素材 =====
// 返回 [{mat, out|error}]，与传入 mats 顺序对应。
// opts: {model, lang, prompt, onFile(i,n,src), onProgress(整体0~1)}
async function transcribeMaterials(projectId, mats, opts = {}) {
  const dir = asrDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const valid = [];
  const srcs = [];
  for (const mat of mats || []) {
    if (!mat || mat.type !== 'video') continue;
    const src = path.join(config.materialDir(projectId), mat.filename);
    if (!fsSync.existsSync(src)) continue;
    valid.push(mat);
    srcs.push(src);
  }
  if (!valid.length) throw new Error('没有可识别的视频素材');

  const results = await runASRBatch(srcs, {
    model: opts.model,
    lang: opts.lang || 'zh',
    prompt: opts.prompt || '',
    onProgress: opts.onProgress,
    onFile: opts.onFile,
    timeout: opts.timeout,
  });

  const out = [];
  for (let i = 0; i < valid.length; i++) {
    const mat = valid[i];
    const r = results[i] || { ok: false, error: '无识别结果' };
    if (!r.ok) {
      out.push({ mat, error: r.error || '识别失败' });
      continue;
    }
    const clean = sanitize(r);
    const speech = speechStats(clean);
    const voiced = hasSpeech(clean);
    const cues = voiced ? cuesFromResult(clean, opts) : [];
    const repeats = voiced ? findRepeats(clean) : { count: 0, items: [] };
    const rel = 'asr/' + mat.id + '.json';
    await fs.writeFile(path.join(dir, mat.id + '.json'), JSON.stringify(r), 'utf8');
    out.push({
      mat,
      out: {
        summary: {
          file: rel,
          engine: r.engine || 'faster-whisper',
          model: r.model,
          language: r.language,
          languageProbability: r.languageProbability,
          duration: r.duration,
          cueCount: cues.length,
          chars: (clean.text || '').replace(/\s/g, '').length,
          text: (clean.text || '').slice(0, 300),
          repeatCount: repeats.items.length,
          speech,
          speechless: !voiced,
          legacy: !!clean.legacy,
          droppedSegments: clean.droppedSegments || 0,
          at: new Date().toISOString(),
        },
        cues,
        repeats,
        result: r,
      },
    });
  }
  return out;
}

// ===== 语速 / 静音统计（音频审核用）=====
function speechStats(result) {  const segs = result.segments || [];
  let speech = 0;
  for (const s of segs) speech += Math.max(0, (s.end || 0) - (s.start || 0));
  const dur = result.duration || 0;
  const chars = (result.text || '').replace(/\s/g, '').length;
  return {
    speech: +speech.toFixed(2),
    ratio: dur ? +(speech / dur).toFixed(3) : 0,
    charsPerSec: speech ? +(chars / speech).toFixed(2) : 0,
  };
}

// ===== 词级时间轴 -> 短句字幕 =====
// 规则：按标点与停顿切分；单行不超过 maxChars；单条不短于 minDur 也不长于 maxDur
function cuesFromResult(result, opt = {}) {
  const maxChars = opt.maxChars || 15;
  const minDur = opt.minDur || 0.85;
  const maxDur = opt.maxDur || 4.5;
  const gapSplit = opt.gapSplit || 0.4;
  const groups = [];
  let cur = null;
  const isPunct = (t) => /^[，。！？；：、,.!?;:~\-—…]+$/.test(t);
  const endsSentence = (t) => /[。！？!?;；]$/.test(t);
  const flush = () => {
    if (cur && cur.toks.length) groups.push(cur);
    cur = null;
  };
  // 先把所有词拉平成一条时间轴（记录段边界），再在其上断句：
  // 优先在段尾 / 句末标点 / 明显停顿处断，实在超长才强制断，避免把一个词劈成两屏
  const toks = [];
  for (const s of result.segments || []) {
    const words = (s.words && s.words.length) ? s.words : null;
    const list = words
      ? words.map((w) => ({ t: String(w.w || '').trim(), s: w.s, e: w.e }))
      : [{ t: String(s.text || '').trim(), s: s.start, e: s.end }];
    list.forEach((tk, i) => {
      if (!tk.t) return;
      tk.isSegLast = i === list.length - 1;
      toks.push(tk);
    });
  }
  if (!toks.length) return [];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (!cur) cur = { toks: [] };
    cur.toks.push(tk);
    const len = cleanLen(cur.toks.map((x) => x.t).join(''));
    const next = toks[i + 1];
    const gap = next ? ((next.s || 0) - (tk.e || 0)) : 0;
    const dur = (tk.e || 0) - (cur.toks[0].s || 0);
    const punct = isPunct(tk.t) || endsSentence(tk.t);
    const breakable = punct || tk.isSegLast || gap > gapSplit;
    // 明显停顿（≥1.2s，含跨段静音）无论长短都断句，避免字幕横跨一段静音
    if (dur > maxDur || len >= maxChars + 6 || gap > 1.2 || (len >= Math.round(maxChars * 0.67) && breakable)) flush();
  }
  flush();

  const cues = [];
  for (const g of groups) {
    let text = g.toks.map((x) => x.t).join('').replace(/\s+/g, '');
    text = text.replace(/^[，。！？；：、,.!?;:~\-—…]+/, '').replace(/[，、,;；：:~\-—…]+$/, '');
    if (!text) continue;
    let start = g.toks[0].s;
    let end = g.toks[g.toks.length - 1].e;
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end) || end <= start) end = start + 0.6;
    // 稍延长收尾，避免字没说完就消失；再保证最短可读时长
    end += 0.10;
    if (end - start < minDur) end = start + minDur;
    if (end - start > maxDur + 1.2) end = start + maxDur + 1.2;
    cues.push({ start: +start.toFixed(2), end: +end.toFixed(2), text });
  }
  // 消除重叠：后一条不与前一条交叠
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i].start = +(cues[i - 1].end + 0.02).toFixed(2);
    if (cues[i].end <= cues[i].start) cues[i].end = +(cues[i].start + minDur).toFixed(2);
  }
  return cues;
}

function cleanLen(s) {
  return String(s || '').replace(/\s+/g, '').replace(/[，。！？；：、,.!?;:~\-—…]/g, '').length;
}

// ===== 重复口播检测 =====
// 把识别文本按标点切成短句，再做「模糊聚类」：识别同音字/语气词差异导致的近似重复
// （例如「腰封有三款」与「我们这个腰锋的话有三款」），给出两处时间点供人工决定剪哪一段。
const FILLERS = ['我们', '你们', '他们', '这个', '那个', '而且', '然后', '就是', '的话', '可以', '一下', '现在', '其实', '所以', '如果', '这样', '那样', '大家', '自己', '一个'];
function normClause(s) {
  let t = String(s || '')
    .replace(/[\s，。！？；：、,.!?;:~\-—…「」『』（）()【】《》"'"'']/g, '')
    .replace(/[的了啊呢吧哦嗯啦呀嘛]/g, '');
  for (const f of FILLERS) t = t.split(f).join('');
  return t;
}
// 编辑距离相似度：对同音误识别（腰封/腰锋）比二元组重合度更宽容
function levRatio(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > Math.min(la, lb)) return 0;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const cur = new Array(lb + 1);
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return 1 - prev[lb] / Math.max(la, lb);
}
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
// Dice 系数：衡量两个短句的二元组重合度（对中文近义/同音误识别比精确匹配稳）
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  const m = new Map();
  for (const g of A) m.set(g, (m.get(g) || 0) + 1);
  let hit = 0;
  for (const g of B) {
    const n = m.get(g) || 0;
    if (n > 0) { hit++; m.set(g, n - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

function findRepeats(result, opt = {}) {
  const minLen = opt.minLen || 4;
  const threshold = opt.threshold || 0.62;
  const clauses = [];
  for (const s of result.segments || []) {
    const parts = String(s.text || '').split(/[，。！？；：、,.!?;:]+/);
    let t = s.start || 0;
    for (const p of parts) {
      const txt = p.replace(/\s+/g, '');
      const n = normClause(txt);
      if (n.length >= minLen) {
        clauses.push({ text: txt, norm: n, start: t, end: Math.min(s.end || t, t + Math.max(1, txt.length * 0.22)) });
      }
      t += Math.max(0.4, p.length * 0.22);
    }
  }
  // 先做精确分组，再把近似句并入已有分组
  const groups = [];
  for (const c of clauses) {
    // 三种命中：完全一致 / 二元组重合 / 编辑距离近似；再加「一句被另一句完整包含」
    let g = groups.find((x) => {
      if (x.norm === c.norm) return true;
      if (dice(x.norm, c.norm) >= threshold) return true;
      if (levRatio(x.norm, c.norm) >= 0.66) return true;
      const shorter = x.norm.length <= c.norm.length ? x.norm : c.norm;
      const longer = x.norm.length > c.norm.length ? x.norm : c.norm;
      return shorter.length >= 4 && longer.includes(shorter);
    });
    if (!g) {
      g = { text: c.text, norm: c.norm, times: [] };
      groups.push(g);
    }
    // 保留更完整的那句作为展示文本
    if (c.text.length > g.text.length) { g.text = c.text; g.norm = c.norm; }
    g.times.push({ start: +c.start.toFixed(2), end: +c.end.toFixed(2) });
  }
  const items = groups
    .filter((x) => x.times.length >= 2)
    .map((x) => ({ text: x.text, times: x.times, n: x.times.length }));
  items.sort((a, b) => b.n - a.n || b.text.length - a.text.length);
  return { count: items.length, items: items.slice(0, 20) };
}

// ===== SRT 导出 =====
function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mss = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(mss).padStart(3, '0')}`;
}

function srtFromCues(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// ===== ASS 字幕（用于 FFmpeg subtitles 滤镜烧录）=====
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function wrapLine(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return [t];
  const count = Math.min(2, Math.ceil(t.length / maxChars));
  const per = Math.ceil(t.length / count);
  const out = [];
  for (let i = 0; i < t.length; i += per) out.push(t.slice(i, i + per));
  return out.slice(0, 2);
}

function assEscape(t) {
  return String(t || '').replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '').replace(/\\/g, '');
}

// CSS/名称颜色 → ASS 的 &HAABBGGRR（小端 BGR）；isOutline 决定缺省色（描边默认黑）
function cssToAss(c, isOutline) {
  if (!c) return isOutline ? '&H00000000' : '&H00FFFFFF';
  c = String(c).trim().toLowerCase();
  const named = {
    white: '&H00FFFFFF', black: '&H00000000', red: '&H000000FF',
    yellow: '&H0000FFFF', green: '&H0000FF00', blue: '&HFFFF0000',
    orange: '&H00008FF', pink: '&H00C8FF', cyan: '&HFFFFFF00', gray: '&H00808080', grey: '&H00808080',
  };
  if (named[c]) return named[c];
  if (c[0] === '#' && c.length >= 7) {
    const r = c.slice(1, 3), g = c.slice(3, 5), b = c.slice(5, 7);
    return `&H00${b}${g}${r}`;
  }
  return isOutline ? '&H00000000' : '&H00FFFFFF';
}

// size: {w,h}；style: {fontSize, pos(0~1 画面高度占比), font, outline, bold, color, outlineColor}
//   style.styles：逐段样式数组（每项同上），style.windows：每段 [start,end] 用于把字幕归属到对应段样式
function assFromCues(cues, size, style = {}) {
  const w = size.w || 1080;
  const h = size.h || 1920;
  const font = style.font || 'Microsoft YaHei';
  const styles = style.styles && style.styles.length ? style.styles : [style];
  const windows = style.windows;
  const styleDefs = styles.map((s, i) => {
    const fontSize = Math.round(s.fontSize || Math.round(h * 0.032));
    const f = s.font || font;
    const outline = s.outline != null ? s.outline : Math.max(2, Math.round(fontSize * 0.075));
    const pos = s.pos != null ? s.pos : 0.76;
    const marginV = Math.max(40, Math.round(h * (1 - pos) - fontSize * 0.6));
    const color = cssToAss(s.color, false);
    const outlineColor = cssToAss(s.outlineColor, true);
    return `Style: Cap${i},${f},${fontSize},${color},${outlineColor},&H90000000,${s.bold === false ? 0 : -1},0,1,${outline},0,2,${Math.round(w * 0.06)},${Math.round(w * 0.06)},${marginV},1`;
  });
  const head = [
    '[Script Info]', 'ScriptType: v4.00+',
    `PlayResX: ${w}`, `PlayResY: ${h}`,
    'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleDefs, '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
  const lines = cues.map((c) => {
    let idx = 0;
    if (windows) {
      idx = windows.findIndex((win) => c.start >= win.start - 0.01 && c.start < win.end - 0.01);
      if (idx < 0) idx = 0;
    }
    const s = styles[idx] || styles[0];
    const fontSize = Math.round(s.fontSize || Math.round(h * 0.032));
    const maxChars = Math.max(6, Math.round((w * 0.86) / fontSize));
    const text = wrapLine(assEscape(c.text), maxChars).join('\\N');
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap${idx},,0,0,0,,${text}`;
  });
  return head + '\n' + lines.join('\n') + '\n';
}

module.exports = {
  status, listModels, defaultModelKey, defaultLabel, modelDir, resolvePython,
  runASR, runASRBatch, transcribeMaterial, transcribeMaterials, readResult, asrDir,
  cuesFromResult, findRepeats, speechStats, srtFromCues, assFromCues, srtTime, wrapLine,
  sanitize, hasSpeech, prewarm, warmState,
};
