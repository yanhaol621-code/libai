// templates.js - 成片模板：决定一条视频的「结构、节奏、字幕、配乐、片尾」
// 设计依据：同行水果店/包装类爆款短视频的通用结构——
//   1) 开头 2 秒抛钩子（大字幕 + 一句人话），先把店老板留住
//   2) 中段 3-6 个镜头快切，镜头多为「整版/堆头 → 装袋装盒动作 → 成品陈列」
//   3) 字幕是短句（8-12 字），一句一屏，讲卖点不讲工艺
//   4) 结尾品牌/厂名 + 一句引导，方便私信询价
// 模板只影响「怎么剪」，不产生任何未经用户确认的产品参数。

const CATEGORY_ORAL = '口播讲解'; // 口播素材单独一类，用于开场或穿插

// 通用镜头优先级（越靠前越容易放在中段）
const ALL_ORDER = ['产品展示', '细节特写', '包装过程', '使用场景', '生产过程', '仓库发货', '口播讲解', '其他'];

const TEMPLATES = {
  // ---------- 口播介绍（对外显示名；原名「同行爆款 · 口播带货」）----------
  oral: {
    key: 'oral',
    name: '口播介绍',
    group: '全部风格',
    desc: '口播开场抛问题 → 产品/包装实拍 → 卖点短句字幕 → 品牌片尾',
    preferOral: true,
    order: [CATEGORY_ORAL, '产品展示', '包装过程', '细节特写', '使用场景', '生产过程', '仓库发货', '其他'],
    paceVideo: 3.0,
    paceImage: 2.6,
    hookDur: 2.4,       // 开场钩子字卡时长（秒）
    hookSize: 0.044,    // 字号 = 视频高度 × 该系数
    captionSize: 0.033, // 正文字幕字号系数
    endingDur: 2.6,     // 片尾卡时长
    captionPos: 0.79,   // 字幕基线位置（占高度比例）
    keepTitle: false,   // 是否在顶部再压一条标题（爆款模板不压，避免双字幕抢视觉）
    musicVolume: 0.32,  // 口播配乐：真实进混音后约比人声低 10dB（0.12 时加上 sidechain 闪避几乎听不见）
  },
  // ---------- 成品展示（对外显示名；原名「同行爆款 · 纯产品展示」）----------
  showcase: {
    key: 'showcase',
    name: '成品展示',
    group: '全部风格',
    desc: '产品全景开场 → 细节/包装/陈列快切 → 卖点短句字幕 → 品牌片尾',
    preferOral: false,
    order: ['产品展示', '细节特写', '包装过程', '使用场景', '仓库发货', '生产过程', '其他', CATEGORY_ORAL],
    paceVideo: 2.5,
    paceImage: 2.4,
    hookDur: 2.0,
    hookSize: 0.044,
    captionSize: 0.033,
    endingDur: 2.4,
    captionPos: 0.79,
    keepTitle: false,
    musicVolume: 0.26,
  },
  // ---------- 以下 5 个为旧模板：仅供已建项目兼容映射，下拉里不显示 ----------
  factory: {
    key: 'factory',
    name: '工厂实力展示',
    group: 'internal',
    hidden: true,
    desc: '生产/包装流程为主，强调产能与做工',
    preferOral: false,
    order: ['生产过程', '包装过程', '仓库发货', '产品展示', '细节特写', '使用场景', '其他', CATEGORY_ORAL],
    paceVideo: 3.0,
    paceImage: 2.8,
    hookDur: 2.2,
    hookSize: 0.041,
    captionSize: 0.032,
    endingDur: 2.4,
    captionPos: 0.78,
    keepTitle: false,
    musicVolume: 0.26,
  },
  detail: {
    key: 'detail',
    name: '产品细节介绍',
    group: 'internal',
    hidden: true,
    desc: '特写为主，慢一点，讲材质与印刷细节',
    preferOral: false,
    order: ['细节特写', '产品展示', '包装过程', '使用场景', '生产过程', '其他', CATEGORY_ORAL],
    paceVideo: 3.4,
    paceImage: 3.0,
    hookDur: 2.2,
    hookSize: 0.041,
    captionSize: 0.032,
    endingDur: 2.4,
    captionPos: 0.78,
    keepTitle: false,
    musicVolume: 0.22,
  },
  scene: {
    key: 'scene',
    name: '使用场景展示',
    group: 'internal',
    hidden: true,
    desc: '以店里/仓库真实使用场景为主',
    preferOral: false,
    order: ['使用场景', '产品展示', '包装过程', '细节特写', '仓库发货', '其他', CATEGORY_ORAL],
    paceVideo: 3.0,
    paceImage: 2.8,
    hookDur: 2.2,
    hookSize: 0.041,
    captionSize: 0.032,
    endingDur: 2.4,
    captionPos: 0.78,
    keepTitle: false,
    musicVolume: 0.24,
  },
  fast: {
    key: 'fast',
    name: '快节奏商品混剪',
    group: 'internal',
    hidden: true,
    desc: '全部镜头压到 1.5-2 秒，节奏最强',
    preferOral: false,
    order: ['产品展示', '细节特写', '包装过程', '使用场景', '生产过程', '仓库发货', '其他', CATEGORY_ORAL],
    paceVideo: 1.9,
    paceImage: 1.8,
    hookDur: 1.8,
    hookSize: 0.040,
    captionSize: 0.030,
    endingDur: 2.0,
    captionPos: 0.78,
    keepTitle: false,
    musicVolume: 0.3,
  },
  daily: {
    key: 'daily',
    name: '真实自然的日常拍摄风格',
    group: 'internal',
    hidden: true,
    desc: '不刻意摆拍，保留原声与环境音',
    preferOral: false,
    order: ['使用场景', '仓库发货', '包装过程', '产品展示', '细节特写', '其他', CATEGORY_ORAL],
    paceVideo: 3.6,
    paceImage: 3.0,
    hookDur: 2.0,
    hookSize: 0.039,
    captionSize: 0.031,
    endingDur: 2.2,
    captionPos: 0.78,
    keepTitle: false,
    musicVolume: 0.16,
  },
};

// 前端下拉里的旧风格名 → 模板（新名 + 历史名都收进来，保证已建项目可解析）
const STYLE_TO_TEMPLATE = {
  '口播介绍': 'oral',
  '成品展示': 'showcase',
  '同行爆款 · 口播带货': 'oral',
  '同行爆款 · 纯产品展示': 'showcase',
  '工厂实力展示': 'factory',
  '产品实拍展示': 'showcase',
  '产品细节介绍': 'detail',
  '使用场景展示': 'scene',
  '快节奏商品混剪': 'fast',
  '产品卖点营销': 'oral',
  '真实自然的日常拍摄风格': 'daily',
};

function forStyle(style) {
  return TEMPLATES[STYLE_TO_TEMPLATE[style]] || TEMPLATES.showcase;
}

// 给前端/接口用的目录（hidden 的模板不显示，仅供已建项目兼容映射）
function list() {
  return Object.values(TEMPLATES)
    .filter((t) => !t.hidden)
    .map((t) => ({
      key: t.key, name: t.name, group: t.group, desc: t.desc,
    }));
}

const STYLE_NAMES = Object.keys(STYLE_TO_TEMPLATE);

module.exports = { TEMPLATES, STYLE_TO_TEMPLATE, STYLE_NAMES, CATEGORY_ORAL, ALL_ORDER, forStyle, list };
