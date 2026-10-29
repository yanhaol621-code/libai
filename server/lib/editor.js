// editor.js - 根据素材与参数生成多版本剪辑方案（时间线）
// 设计原则：
// 1. 同款产品隔离：仅使用本项目素材，跨产品需用户确认（由前端/参数控制）。
// 2. 商品展示优先：优先清晰、稳定、完整镜头。
// 3. 多版本差异：通过"开场类型 + 镜头顺序 + 节奏 + 字幕"真正区分，避免完全相同的镜头顺序。
// 4. 诚实：素材不足时明确警告，不靠大量重复镜头伪装成不同版本。
// 5. 成片结构对齐同行爆款：开场钩子字卡 → 快切镜头 + 短句字幕 → 品牌片尾卡。

const ai = require('./ai');
const templates = require('./templates');

// 版本差异：开场偏好 + 镜头顺序 + 是否快切
const VARIANTS = [
  { key: 'A', label: '整体展示', opening: ['产品展示', '细节特写'], order: ['产品展示', '细节特写', '使用场景', '生产过程', '包装过程', '仓库发货'], cap: 5 },
  { key: 'B', label: '工厂实力', opening: ['生产过程', '包装过程'], order: ['生产过程', '包装过程', '产品展示', '细节特写', '使用场景'], cap: 5 },
  { key: 'C', label: '使用场景', opening: ['使用场景'], order: ['使用场景', '产品展示', '细节特写', '生产过程', '包装过程'], cap: 5 },
  { key: 'D', label: '细节快切', opening: ['细节特写'], order: ['细节特写', '产品展示', '细节特写', '使用场景', '细节特写'], cap: 2.6, fast: true },
  { key: 'E', label: '卖点开场', opening: ['产品展示'], order: ['产品展示', '细节特写', '使用场景', '包装过程', '生产过程'], cap: 4, titleFirst: true },
];

const IMG_DUR = 4; // 图片默认展示时长上限（秒），实际取模板节奏

// 过滤素材：仅使用"已分析"且未禁止的素材；优先必用 + 可用；不足时退而使用全部已分析素材
function filterMaterials(materials) {
  // 步骤门槛：只有「一次修改」里点过完成的素材才往后走，未改完的不参与成片
  const edited = materials.filter((m) => m.editDone);
  const waiting = materials.length - edited.length;
  // 审核后被排除的镜头不进候选库（非破坏性：原文件仍在，可随时恢复）
  const analyzed = edited.filter((m) => !m.forbidden && !m.excluded && m.status === 'analyzed');
  const required = analyzed.filter((m) => m.required || m.mustKeep);
  // 有审核结论时以审核为准；没跑过审核则退回旧的 usable 标记
  const judged = analyzed.filter((m) => m.inspect && m.inspect.bucket);
  const pickUsable = (m) => {
    if (m.inspect && m.inspect.bucket) {
      return ['优质可用', '可裁切优化', '可修复', '待确认'].includes(m.inspect.bucket);
    }
    return m.usable !== false;
  };
  const usable = analyzed.filter((m) => pickUsable(m) && !m.required && !m.mustKeep);
  let pool = [...required, ...usable];
  const warnings = [];
  // 重复镜头：只保留 AI 判定的"最佳版本"，避免成片里反复出现同一画面
  // 注意：重复镜头在 pickUsable 阶段已被挡掉，所以这里从 analyzed 统计才有数
  const dup = analyzed.filter((m) => m.inspect && m.inspect.duplicateOf && !m.mustKeep);
  if (dup.length) {
    pool = pool.filter((m) => !(m.inspect && m.inspect.duplicateOf) || m.mustKeep);
    warnings.push(`已自动剔除 ${dup.length} 个重复镜头（保留画质/稳定性最佳的一条，可在审核页恢复）。`);
  }
  if (pool.length === 0 && analyzed.length > 0) {
    pool = analyzed;
    warnings.push('当前没有"可用"素材（多为模糊/黑屏/静音），已退而使用全部已分析素材，请人工筛选。');
  }
  if (pool.length === 0) {
    warnings.push(waiting > 0
      ? `还有 ${waiting} 个素材没在「② 一次修改」里点「完成修改」，先回去处理完才能生成。`
      : '还没有任何"已分析"的素材，无法生成视频。请先上传素材并等待分析完成。');
  }
  return { pool, warnings };
}

// 素材人工分类（运营在「一次修改」里手动选）：开头 / 片尾 / 材质 / 规格 / 讲解
// 决定自动混剪里的出场位置——开头放第一段、片尾收最后、材质→规格→讲解排在中间
const PART_RANK = { '开头': 0, '材质': 1, '规格': 2, '讲解': 3, '片尾': 9 };
function partRank(m) {
  const r = PART_RANK[m && m.part];
  return r === undefined ? 4 : r;   // 没分类的排在已分类后面、片尾前面，保持原顺序
}

// 按模板镜头优先级排序（模板决定"这类内容先讲什么"）
function orderByTemplate(pool, template) {
  const rank = (cat) => {
    const i = template.order.indexOf(cat);
    return i === -1 ? 999 : i;
  };
  return pool
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m.category) - rank(b.m.category) || a.i - b.i)
    .map((x) => x.m);
}

// 有人工分类时以分类为主序、模板镜头顺序为次序；都没分类就完全按模板（和以前一致）
function orderByPart(pool, template) {
  const base = orderByTemplate(pool, template);
  if (!base.some((m) => m.part)) return base;
  return base
    .map((m, i) => ({ m, i }))
    .sort((a, b) => partRank(a.m) - partRank(b.m) || a.i - b.i)
    .map((x) => x.m);
}

// 选择开场素材：口播模板优先口播，其余用版本自己的开场偏好
function pickOpening(pool, variant, template) {
  if (template.preferOral) {
    const oral = pool.find((m) => m.category === templates.CATEGORY_ORAL && m.type === 'video');
    if (oral) return oral;
    // 没标"口播讲解"但有真实人声的素材，同样优先开场（以识别结果为准，不靠猜）
    const voiced = pool.find((m) => m.type === 'video' && (m.asrCues || []).length > 0);
    if (voiced) return voiced;
  }
  for (const cat of variant.opening) {
    const m = pool.find((x) => x.category === cat);
    if (m) return m;
  }
  return pool[0];
}

// ===== Mode B：口播片段按"整句"切 =====
// 口播素材不能按固定时长硬切：会切在半句话上，也会把重复口播放两遍。
// 这里以字幕（= 自然句）为最小单位打包成镜头：一段 = 连续几句，时长凑到目标节奏。
const FILLER_RE = /(我们|你们|他们|这个|那个|而且|然后|就是|的话|可以|一下|现在|其实|所以|如果|这样|那样|大家|自己|一个|[的了啊呢吧哦嗯啦呀嘛]|\s|[，。！？；：、,.!?;:])/g;
function simplify(s) { return String(s || '').replace(FILLER_RE, ''); }

function isSameSentence(a, b) {
  const x = simplify(a), y = simplify(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y;
  const long = x.length > y.length ? x : y;
  return short.length >= 4 && long.includes(short);
}

// 把某素材的字幕时间轴打包成若干镜头片段（不跨越句子边界）
function oralChunks(mat, { chunkDur, maxDur, usedSentences }) {
  const cues = (mat.asrCues || []).slice().sort((a, b) => a.start - b.start);
  if (!cues.length) return [];
  const out = [];
  let cur = null;
  for (const c of cues) {
    // 重复口播只保留第一次出现，后面再讲一遍的整句直接跳过
    if (usedSentences && usedSentences.some((s) => isSameSentence(s, c.text))) {
      if (cur && cur.dur >= chunkDur * 0.6) { out.push(cur); cur = null; }
      continue;
    }
    const d = Math.max(0.4, (c.end || 0) - (c.start || 0));
    if (!cur) {
      cur = { start: c.start, end: c.end, dur: d, texts: [c.text] };
    } else {
      // 句间静音太长就收口，避免镜头里夹一大段空白
      if (c.start - cur.end > 1.2) {
        out.push(cur);
        cur = { start: c.start, end: c.end, dur: d, texts: [c.text] };
      } else {
        cur.end = c.end;
        cur.dur += d;
        cur.texts.push(c.text);
      }
    }
    if (usedSentences) usedSentences.push(c.text);
    if (cur.dur >= chunkDur || cur.dur >= maxDur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((c) => ({ srcStart: c.start, srcDur: Math.max(0.8, Math.min(c.dur, maxDur)) }));
}

function clipDuration(mat, template, variant) {
  const image = mat.type === 'image';
  const cap = image ? template.paceImage : template.paceVideo;
  const limit = variant.fast ? Math.min(cap, 1.9) : cap;
  if (image) return Math.min(IMG_DUR, limit);
  const d = mat.duration || limit;
  return Math.min(Math.max(d, 0.8), limit);
}

// 分配短句字幕：开场由钩子字卡负责，所以第一段不重复上字幕
function captionFor(idx, script, offset) {
  if (idx === 0) return '';
  const list = script.captions;
  if (!list.length) return '';
  return list[(idx - 1 + offset) % list.length];
}

// 素材原始可用时长（不受模板节奏上限约束，按真实内容拼接）
function rawDur(mat) {
  if (mat.type === 'image') return IMG_DUR;
  return Math.max(0.8, Number(mat.duration) || 4);
}

// 构建单个版本方案（新模型：开头1 + 中间按分类顺序按原时长混搭 + 片尾1）
// 顺序严格：开头 → 材质 → 规格 → 讲解 → 未分类 → 片尾；开头/片尾各 1 个素材，
// 中间按总时长自动从材质/规格/讲解（及未分类）循环取素材。
// 时长语义：目标时长只是「至少加到这么长」的下限；每条素材都完整播完（口播按整句），
// 宁可成片比目标长一点，也不把素材话说到一半就切镜头。
function buildVersion(project, pool, variant, script, usedSigs, template, n) {
  const ordered = orderByPart(pool, template);
  const target = project.duration || 30;

  // 开头：取「开头」分类素材 1 个（多版本轮转产生差异）；没有则用第一个可用素材兜底
  const openCands = ordered.filter((m) => m.part === '开头');
  const endCands = ordered.filter((m) => m.part === '片尾');
  const openMat = openCands.length ? openCands[n % openCands.length] : (ordered[0] || null);
  const endMat = endCands.length
    ? endCands[n % endCands.length]
    : (ordered[ordered.length - 1] || openMat);

  // 中间候选：材质 → 规格 → 讲解 → 未分类（按分类顺序），循环取原始时长拼接
  const middle = ordered.filter(
    (m) => m.id !== (openMat && openMat.id) && m.id !== (endMat && endMat.id)
      && m.part !== '开头' && m.part !== '片尾'
  );

  const used = {};
  const segments = [];
  const usedSentences = [];                 // 口播素材：已被用过的整句不再重复
  const chunkDur = Math.min(template.paceVideo || 3.5, 4);
  const chunkMax = chunkDur + 1.2;
  let total = 0;

  // 1) 开头段：完整播完（口播按整句切完该素材的所有句子，避免腰斩）
  if (openMat) {
    if (template.preferOral && openMat.type === 'video' && (openMat.asrCues || []).length) {
      const off = (openMat.beauty || openMat.optimized) && Number.isFinite((openMat.beauty || openMat.optimized).in) ? (openMat.beauty || openMat.optimized).in : 0;
      for (const ch of oralChunks(openMat, { chunkDur, maxDur: chunkMax, usedSentences })) {
        const sp = speedOf(openMat);
        const seg = makeSeg(openMat, ch.srcDur / sp, '', segments.length, false, used, Math.max(0, ch.srcStart - off));
        if (!seg) continue;
        segments.push(seg); total += seg.srcDur;
      }
    } else {
      const seg = makeSeg(openMat, rawDur(openMat), '', segments.length, false, used);
      if (seg) { segments.push(seg); total += seg.srcDur; }
    }
  }

  // 2) 中间：按分类顺序循环、每条完整播完；加到够目标时长就停（最后一条不截断，略微超出没问题）
  let guard = 0;
  let mi = middle.length ? (n % middle.length) : 0;
  while (middle.length && total < target - 0.2 && guard < 400) {
    const m = middle[mi % middle.length]; mi++; guard++;
    const seg = makeSeg(m, rawDur(m), '', segments.length, false, used);
    if (!seg) continue;
    segments.push(seg); total += seg.srcDur;
  }

  // 3) 片尾段：完整播完（若已用过则跳过避免重复）
  if (endMat && !segments.some((s) => s.materialId === endMat.id)) {
    const seg = makeSeg(endMat, rawDur(endMat), '', segments.length, false, used);
    if (seg) { segments.push(seg); total += seg.srcDur; }
  }

  const sig = 'P' + (n + 1) + '|' + segments.map((s) => s.materialId).join(',');
  const duplicate = usedSigs.has(sig);
  usedSigs.add(sig);

  return {
    version: 'P' + (n + 1),
    label: '按分类混搭',
    title: (project.subtitle && project.subtitle.showTitle) ? ai.generateTitle(project, '按分类混搭') : '',
    hook: '',
    ending: {},
    template: {
      key: template.key,
      name: template.name,
      hookDur: template.hookDur,
      hookSize: template.hookSize,
      captionSize: template.captionSize,
      captionPos: template.captionPos,
      endingDur: template.endingDur,
      keepTitle: template.keepTitle,
      musicVolume: template.musicVolume,
      preferOral: !!template.preferOral,
    },
    pureMaterial: true,   // 纯素材拼接：不画开场钩子字卡 / 片尾品牌卡
    segments,
    totalDuration: +total.toFixed(1),
    targetDuration: target,
    recycled: false,
    duplicate,
    style: project.style,
  };
}

// 素材可用区间（时间都按"实际读取的文件"表达：用美颜/优化副本时从 0 开始，用原片时就是原片时间轴）
// 「一次修改」里可以从中间截断成多段并删掉卡顿部分，所以这里统一返回若干互不重叠的片段
function speedOf(mat) {
  const s = Number(mat && mat.speed);
  return s > 0 && s !== 1 ? s : 1;
}

// ===== 多轨时间轴解析 =====
// 3 条画面轨（V1 底 → V3 顶）+ 2 条音频轨（A1 底 → A2 顶），成片按「上层盖下层」合成：
// 同一时刻取轨号最大的那条，轨道空白处 = 黑场 / 静音。
// 解析结果是一串按时间排序、互不重叠的片段：{ t0, dur, vsrc|null, asrc|null }
// vsrc / asrc 都是「相对所用文件（美颜/优化副本或原片）的时间」。
function clampLane(v, n) {
  const i = Math.round(Number(v));
  if (!Number.isFinite(i)) return 0;
  return Math.max(0, Math.min(n - 1, i));
}
// 用已占用的区间把一段裁掉，返回剩下的碎片
function subtractIv(iv, occ) {
  let out = [Object.assign({}, iv)];
  for (const o of occ) {
    const next = [];
    for (const p of out) {
      if (o.end <= p.start + 0.001 || o.start >= p.end - 0.001) { next.push(p); continue; }
      if (o.start > p.start) next.push({ start: p.start, end: o.start, src: p.src });
      if (o.end < p.end) next.push({ start: o.end, end: p.end, src: p.src + (o.end - p.start) });
    }
    out = next;
    if (!out.length) break;
  }
  return out.filter((p) => p.end - p.start > 0.001);
}

function timelineOf(mat) {
  if (mat.__tl) return mat.__tl;
  const optSrc = mat.beauty || mat.optimized;
  const off = optSrc && Number.isFinite(optSrc.in) ? optSrc.in : 0;
  const avail = optSrc ? Math.max(0, optSrc.duration || mat.duration || 0) : Math.max(0, mat.duration || 0);
  const src = [];
  if (Array.isArray(mat.pieces) && mat.pieces.length) {
    for (const p of mat.pieces) {
      const tin = (Number(p.in) || 0) - off;
      const tout = (Number(p.out) || 0) - off;
      const s = Math.max(0, tin), e = Math.min(avail, tout);
      if (avail > 0.3 && e - s <= 0.2) continue;
      const shift = s - tin;                       // 被夹掉的前半截
      const dur = Math.max(0.1, e - s);
      const t0 = Math.max(0, (Number.isFinite(Number(p.t0)) ? Number(p.t0) : 0) + shift);
      const hasOwn = Number.isFinite(Number(p.aIn)) && Number.isFinite(Number(p.aOut))
        && Number(p.aOut) - Number(p.aIn) > 0.1;
      const aMute = !!p.aMute || !!mat.muted;
      const alen = aMute ? 0 : Math.max(0, hasOwn ? Math.min(Number(p.aOut) - Number(p.aIn), dur) : dur);
      src.push({
        v: clampLane(p.v, 3), aLane: clampLane(p.a, 2),
        t0, dur, vsrc: s,
        // 声音自己摆过位置就用它的时间轴位置，否则跟着画面
        at0: Number.isFinite(Number(p.aT0)) ? Math.max(0, Number(p.aT0)) : t0,
        asrc: hasOwn ? Math.max(0, Number(p.aIn) - off) : s,
        alen,
      });
    }
  } else {
    const tin = Number.isFinite(mat.trimIn) ? mat.trimIn : 0;
    const tout = Number.isFinite(mat.trimOut) ? mat.trimOut : (mat.duration || 0);
    const s = Math.max(0, Math.min(tin - off, avail || tin - off));
    const e = Math.max(s, Math.min(tout - off, avail || tout - off));
    const dur = Math.max(0.1, e - s);
    src.push({ v: 0, aLane: 0, t0: 0, dur, vsrc: s, at0: 0, asrc: s, alen: mat.muted ? 0 : dur });
  }

  // 画面：高轨优先，逐层减掉被上层盖住的部分
  const video = [];
  {
    const occ = [];
    const order = src.slice().sort((a, b) => b.v - a.v || b.t0 - a.t0);
    for (const p of order) {
      const iv = { start: p.t0, end: p.t0 + p.dur, src: p.vsrc };
      for (const piece of subtractIv(iv, occ)) video.push(piece);
      occ.push({ start: iv.start, end: iv.end });
    }
  }
  // 音频：高音轨优先（与画面同一套上层覆盖规则）
  const audio = [];
  {
    const occ = [];
    const order = src.filter((p) => p.alen > 0.05)
      .sort((a, b) => b.aLane - a.aLane || b.at0 - a.at0);
    for (const p of order) {
      const iv = { start: p.at0, end: p.at0 + p.alen, src: p.asrc };
      for (const piece of subtractIv(iv, occ)) audio.push(piece);
      occ.push({ start: iv.start, end: iv.end });
    }
  }

  // 合并画面与音频的边界，切成同一套基本区间
  const marks = new Set([0]);
  for (const x of video.concat(audio)) { marks.add(+x.start.toFixed(3)); marks.add(+x.end.toFixed(3)); }
  const pts = [...marks].sort((a, b) => a - b);
  const find = (list, t) => list.find((x) => t >= x.start - 0.001 && t < x.end - 0.001) || null;
  const clips = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = b - a;
    if (d < 0.005) continue;
    const v = find(video, a), au = find(audio, a);
    const clip = {
      t0: +a.toFixed(3), dur: +d.toFixed(3),
      vsrc: v ? +(v.src + (a - v.start)).toFixed(3) : null,
      asrc: au ? +(au.src + (a - au.start)).toFixed(3) : null,
    };
    const prev = clips[clips.length - 1];
    const join = prev
      && Math.abs(prev.t0 + prev.dur - clip.t0) < 0.006
      && ((prev.vsrc == null && clip.vsrc == null)
        || (prev.vsrc != null && clip.vsrc != null && Math.abs(prev.vsrc + prev.dur - clip.vsrc) < 0.006))
      && ((prev.asrc == null && clip.asrc == null)
        || (prev.asrc != null && clip.asrc != null && Math.abs(prev.asrc + prev.dur - clip.asrc) < 0.006));
    if (join) prev.dur = +(prev.dur + clip.dur).toFixed(3);
    else clips.push(clip);
  }
  // 从时间轴 0 开始补黑场（片段整体后移时，前面那段是黑场，保留时长）
  const first = clips.find((c) => c.dur > 0.05);
  if (first && first.t0 > 0.05) {
    clips.unshift({ t0: 0, dur: +first.t0.toFixed(3), vsrc: null, asrc: null });
  }
  const total = clips.reduce((a, c) => a + c.dur, 0);
  const tl = { clips, total: +total.toFixed(3) };
  mat.__tl = tl;
  return tl;
}

// 可在成片里取用的区间（时间轴坐标）：只算有内容的地方，空白不占位
function spansFor(mat) {
  const tl = timelineOf(mat);
  const spans = [];
  for (const c of tl.clips) {
    if (c.dur <= 0.2) continue;
    if (c.vsrc == null && c.asrc == null) continue;
    const last = spans[spans.length - 1];
    if (last && Math.abs(last.end - c.t0) < 0.006) last.end = +(c.t0 + c.dur).toFixed(3);
    else spans.push({ start: c.t0, end: +(c.t0 + c.dur).toFixed(3) });
  }
  return spans;
}

// 一段成片时间窗 → 若干「源片段」（每个都自带画面起点和声音起点）
// 这样多轨重叠、留黑场、声音独立摆放都能被精确表达出来
function partsFor(mat, tStart, len, speed) {
  const tl = timelineOf(mat);
  const parts = [];
  const end = tStart + len;
  for (const c of tl.clips) {
    const cs = Math.max(c.t0, tStart), ce = Math.min(c.t0 + c.dur, end);
    if (ce - cs < 0.04) continue;
    const d = ce - cs;
    parts.push({
      srcStart: c.vsrc == null ? null : +(c.vsrc + (cs - c.t0)).toFixed(3),
      audioStart: c.asrc == null ? null : +(c.asrc + (cs - c.t0)).toFixed(3),
      srcLen: +d.toFixed(3),
      srcDur: +(d / speed).toFixed(3),
      mute: c.asrc == null,
    });
  }
  return parts;
}

// 从素材里按游标取一段（同一素材在成片里出现多次时往后顺延，避免反复放同一个开头）
// 不会跨越被删掉的中间段；取空了返回 null，recycled 场景允许从头回卷重播
function takeFromMat(mat, used, wantSrc, wrap) {
  const spans = spansFor(mat);
  if (!spans.length) return null;
  const cur = used && Number.isFinite(used[mat.id]) ? used[mat.id] : spans[0].start;
  const pick = (from) => {
    for (const sp of spans) {
      if (sp.end <= from + 0.05) continue;
      const start = Math.max(from, sp.start);
      if (sp.end - start < 0.3) continue;          // 只剩尾巴，换下一段
      return { start, len: Math.min(wantSrc, sp.end - start) };
    }
    return null;
  };
  let r = pick(cur);
  if (!r) {
    if (!wrap) return null;
    r = pick(spans[0].start);
    if (!r) return null;
  }
  if (used) used[mat.id] = r.start + r.len;
  return r;
}

// 指定起点（口播按整句切）时，把这一段夹进用户保留的片段里，不跨过删掉的部分
// srcStart 是原片时间（来自字幕时间轴），要先换算成时间轴位置
function fitSpan(mat, srcStart, wantSrc) {
  const tl = timelineOf(mat);
  const hit = tl.clips.find((c) => c.vsrc != null && srcStart >= c.vsrc - 0.05 && srcStart < c.vsrc + c.dur + 0.05);
  if (!hit) return null;
  const pos = hit.t0 + Math.max(0, srcStart - hit.vsrc);
  const spans = spansFor(mat);
  for (const sp of spans) {
    if (pos >= sp.end - 0.05) continue;
    const start = Math.max(pos, sp.start);
    if (sp.end - start < 0.3) continue;
    return { start, len: Math.min(wantSrc, sp.end - start) };
  }
  return null;
}

// （音频分层已并入 timelineOf：每个片段自带 asrc，成片按时间轴精确取声，见 partsFor）

function makeSeg(mat, wantDur, caption, idx, recycled, used, forcedStart) {
  const srcFile = (mat.beauty || mat.optimized) ? (mat.beauty || mat.optimized).file : null;
  const base = {
    materialId: mat.id,
    type: mat.type,
    category: mat.category,
    sellPoint: caption || '',
    recycled: !!recycled,
    // 美颜副本 > 优化副本 > 原片（美颜/优化都已按一次修改截好，原文件不动）
    srcFile,
    volume: Number.isFinite(mat.volume) ? mat.volume : 1,
  };
  if (mat.type === 'image') {
    return Object.assign(base, { srcStart: 0, srcDur: Math.max(0.4, wantDur), speed: 1, mute: true });
  }
  const speed = speedOf(mat);
  const wantSrc = Math.max(0.4, wantDur) * speed;
  const r = Number.isFinite(forcedStart) ? fitSpan(mat, forcedStart, wantSrc) : takeFromMat(mat, used, wantSrc, !!recycled);
  if (!r) return null;                              // 这段素材已经被用户裁没了
  // 多轨时间轴：这一段可能跨过「上层覆盖/黑场/声音独立摆放」的边界，拆成若干源片段
  const parts = partsFor(mat, r.start, r.len, speed);
  if (!parts.length) return null;
  const outDur = parts.reduce((a, p) => a + p.srcDur, 0);
  const firstV = parts.find((p) => p.srcStart != null) || parts[0];
  return Object.assign(base, {
    srcStart: firstV.srcStart == null ? 0 : firstV.srcStart,
    srcDur: +outDur.toFixed(3),                     // 成片时间轴长度（源时长 / 倍率）
    speed,
    audioStart: firstV.mute ? null : firstV.audioStart, // null = 从画面同一点起取声音
    mute: !!firstV.mute,
    parts,                                          // 精确渲染用（老的单段数据也有一份，不影响旧逻辑）
  });
}


// 主入口：生成全部版本方案
function buildPlans(project) {
  const materials = project.materials || [];
  for (const m of materials) delete m.__tl;   // 清掉上一次解析的时间轴缓存
  const { pool, warnings } = filterMaterials(materials);
  const template = templates.forStyle(project.style);
  const script = ai.buildScript(project);
  const sellPoints = ai.generateSellPoints(project); // 兼容旧调用方
  const count = Math.max(1, parseInt(project.count || 1, 10));
  const usedSigs = new Set();
  const versions = [];
  for (let n = 0; n < count; n++) {
    const variant = VARIANTS[n % VARIANTS.length];
    versions.push(buildVersion(project, pool, variant, script, usedSigs, template, n));
  }
  if (pool.length < count) {
    warnings.push(`素材数量(${pool.length})少于生成数量(${count})，多版本将复用相同镜头但采用不同开场/顺序；建议补充素材以获得更丰富的差异。`);
  }
  const anyDuplicate = versions.some((v) => v.duplicate);
  if (anyDuplicate) warnings.push('检测到版本镜头顺序高度相似，已尽量错开开场与顺序。');
  if (template.preferOral && !pool.some((m) => m.category === templates.CATEGORY_ORAL)) {
    warnings.push('这是「口播带货」模板，但没有标记为「口播讲解」的素材；已用产品展示镜头开场，建议上传口播素材并在素材卡里把分类改成「口播讲解」。');
  }
  return { versions, sellPoints, warnings, poolSize: pool.length, template: template.name, script };
}

module.exports = { buildPlans, VARIANTS, IMG_DUR, filterMaterials, timelineOf, partsFor, speedOf };
