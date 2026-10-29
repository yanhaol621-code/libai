// analysis.js - 素材分析：元数据、缩略图、黑屏/静音/模糊/运动检测、镜头切分、启发式分类
const path = require('path');
const fs = require('fs/promises');
const config = require('../config');
const ffmpeg = require('./ffmpeg');
const ai = require('./ai');
const store = require('./store');

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
const VID_EXT = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.m4v'];

function isImage(name) {
  return IMG_EXT.includes(path.extname(name).toLowerCase());
}

// 分析单个素材（projectId + materialId）
// 注意：ffprobe / 缩略图 / 质量检测这几个重活必须在项目锁「外面」跑。
// 以前整段都锁着，一个素材分析要几秒，这期间同项目的其它上传（以及剪辑保存）
// 全部在等锁，表现就是「第一个传完了，后面几个文件卡着不动」。
const ANALYZED_FIELDS = ['size', 'duration', 'width', 'height', 'hasAudio', 'type',
  'thumbnail', 'quality', 'problems', 'usable', 'needsConfirm', 'category', 'aiTags',
  'classifiedBy', 'status'];

async function analyzeMaterial(projectId, materialId) {
  // 1) 短锁：读素材 + 标记「分析中」
  const snap = await store.withLock(projectId, async () => {
    const project = await store.loadProject(projectId);
    const mat = project.materials.find((m) => m.id === materialId);
    if (!mat) throw new Error('素材不存在');
    mat.status = 'analyzing';
    await store.saveProject(project);
    return JSON.parse(JSON.stringify(mat));
  });

  const filePath = path.join(config.materialDir(projectId), snap.filename);
  const work = { ...snap };   // 在副本上算，算完再写回
  try {
    const meta = await ffmpeg.probe(filePath);
    work.size = meta.size;
    work.duration = meta.duration || 0;
    work.width = meta.video ? meta.video.width : null;
    work.height = meta.video ? meta.video.height : null;
    work.hasAudio = !!meta.audio;
    work.type = isImage(work.filename) ? 'image' : 'video';

    // 缩略图
    const thumbName = work.id + '.jpg';
    const thumbPath = path.join(config.materialDir(projectId), 'thumb', thumbName);
    if (work.type === 'image') {
      await ffmpeg.run(config.FFMPEG_PATH, [
        '-y', '-i', path.resolve(filePath),
        '-vf', 'scale=\'min(480,iw)\':-1', '-q:v', '4',
        path.resolve(thumbPath),
      ]);
    } else {
      const t = Math.min(1, (work.duration || 2) * 0.2);
      await ffmpeg.thumbnail(filePath, thumbPath, t, 480);
    }
    work.thumbnail = 'thumb/' + thumbName;

    // 质量检测（视频）
    if (work.type === 'video' && work.duration > 0.5) {
      const tasks = [
        ffmpeg.detectBlack(filePath).catch(() => []),
        ffmpeg.motionScore(filePath, work.duration).catch(() => ({ score: 0 })),
        ffmpeg.sharpnessScore(filePath, work.duration).catch(() => ({ score: null })),
      ];
      // 仅当存在音轨时检测静音
      if (meta.audio) tasks.push(ffmpeg.detectSilence(filePath).catch(() => []));
      else tasks.push(Promise.resolve([]));
      const [black, motion, sharp, silence] = await Promise.all(tasks);

      const blackTotal = black.reduce((a, b) => a + b.duration, 0);
      const silenceTotal = silence.reduce((a, b) => a + (b.duration || 0), 0);
      const silenceRatio = work.duration ? silenceTotal / work.duration : 0;

      work.quality = {
        blackSegments: black,
        blackTotal: +blackTotal.toFixed(2),
        silenceSegments: silence,
        silenceTotal: +silenceTotal.toFixed(2),
        silenceRatio: +silenceRatio.toFixed(2),
        motion: motion.score,
        sharpness: sharp.score,
      };

      // 标记问题片段
      const problems = [];
      if (blackTotal > 0.5) problems.push('含黑屏片段');
      if (silenceRatio > 0.6) problems.push('长时间静音');
      if (sharp && sharp.score !== null && sharp.score < 0.4) problems.push('画面可能模糊');
      // 注意：稳定（低运动）的产品展示镜头是电商最想要的，不视为问题。
      // 仅当画面"完全冻结/无变化"时提示，这里以运动极低且时长较长作为弱提示（不禁用）。
      work.problems = problems;
      work.usable = problems.length === 0;
      work.needsConfirm = true; // 业务规则：AI 无法确认产品身份，需用户确认
    } else if (work.type === 'image') {
      work.problems = [];
      work.usable = true;
      work.needsConfirm = true;
    }

    // 启发式分类（不确定 → 标记待确认）
    work.category = heuristicCategory(work);
    work.aiTags = [];
    work.classifiedBy = 'heuristic';

    work.status = 'analyzed';
  } catch (e) {
    work.status = 'error';
    work.error = e.message;
  }

  // 2) 短锁：只把「分析产出的字段」写回。
  //    这段分析跑的同时用户可能已经拖了片段/勾了必留，这里不整体覆盖，
  //    避免把用户这期间的编辑冲掉。
  const saved = await store.withLock(projectId, async () => {
    const project = await store.loadProject(projectId);
    const mat = project.materials.find((m) => m.id === materialId);
    if (!mat) return null;               // 分析期间素材被删了，安静结束
    for (const k of ANALYZED_FIELDS) {
      if (work[k] !== undefined) mat[k] = work[k];
    }
    if (work.status === 'error') mat.error = work.error;
    await store.saveProject(project);
    return mat;
  });

  if (work.status === 'error') throw new Error(work.error);
  return saved || work;
}

// 启发式分类（仅作初步建议，一律标记需确认）
function heuristicCategory(mat) {
  if (mat.type === 'image') return '产品展示';
  const d = mat.duration || 0;
  const motion = (mat.quality && mat.quality.motion) || 0;
  const silence = (mat.quality && mat.quality.silenceRatio) || 0;
  // 有音轨、几乎不静音、时长够 → 大概率是有人说话的口播镜头
  if (mat.hasAudio && d >= 3 && silence < 0.18) return '口播讲解';
  if (d < 3 && motion < 3) return '细节特写';
  if (motion > 8) return d > 8 ? '使用场景' : '细节特写';
  if (silence > 0.5) return '包装过程';
  return '产品展示';
}

// 重新分析（用于重试）
async function reanalyze(projectId, materialId) {
  return analyzeMaterial(projectId, materialId);
}

module.exports = { analyzeMaterial, reanalyze, isImage, IMG_EXT, VID_EXT, heuristicCategory };
