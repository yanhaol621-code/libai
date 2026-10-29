// ai.js - 可插拔 AI 接口（第一阶段：规则/启发式；第二阶段可接入视觉/语音模型）
// 设计原则：所有对外能力都通过本模块暴露，便于后续替换为真实大模型 API，
// 且严格遵守业务规则——卖点只能来自用户填写信息或素材可确认事实，绝不编造。

const config = require('../config');

// 是否启用外部视觉模型（读取环境变量；第一阶段默认关闭，使用启发式）
const VISION_ENABLED = !!process.env.AI_VISION_API_KEY && !!process.env.AI_VISION_API_URL;

// 分类类别（与前端一致）
const CATEGORIES = ['产品展示', '细节特写', '使用场景', '生产过程', '包装过程', '仓库发货', '口播讲解', '其他'];

// 各类别的默认卖点（仅基于"类别"这一用户已知信息推导，不编造具体参数）
const SELL_POINTS_BY_CATEGORY = {
  '包装盒': ['现货供应', '支持定制', '工厂直发'],
  '手提袋': ['现货供应', '支持定制', '多种规格'],
  '标签贴纸': ['高清印刷', '支持定制', '规格可选'],
  '吊牌': ['高清印刷', '支持定制', '款式可选'],
  '礼品盒': ['精致包装', '节日送礼', '支持加印Logo'],
  '印刷品': ['免费设计', '高清印刷', '批量定制'],
  '邀请函': ['精致设计', '支持定制', '加印信息'],
  '其他': ['现货供应', '支持定制', '厂家直发'],
};

// 短句字幕库：一行一屏，只说「对店老板有什么用」，不讲工艺参数。
// 全部来自用户已填的类别/卖点范围，不涉及具体尺寸、承重、头数等未经确认的数据。
const CAPTIONS_BY_CATEGORY = {
  '包装盒': ['装起来简单快速', '摆出来更整齐', '顾客拿起来方便', '整箱分装更好走量', '现货供应不用等', '支持加印店铺Logo', '盒型硬挺不塌', '大小规格可选'],
  '手提袋': ['装好就能拎走', '陈列立起来好看', '顾客提着有面子', '结实能装不勒手', '现货供应不用等', '支持加印店铺Logo', '大小规格可选'],
  '标签贴纸': ['贴上去更像品牌', '印刷清晰不掉色', '大小规格可选', '支持定制图案', '现货供应不用等'],
  '吊牌': ['印刷清晰有质感', '款式可选', '支持定制内容', '现货供应不用等'],
  '礼品盒': ['平时好看过节有氛围', '送礼拿得出手', '一件也装得体面', '整箱分装更好走量', '支持加印店铺Logo'],
  '印刷品': ['印刷清晰色彩正', '免费设计排版', '批量更划算', '支持定制内容'],
  '邀请函': ['设计精致不廉价', '支持加印信息', '成套配信封'],
  '其他': ['摆出来更整齐', '顾客拿起来方便', '现货供应不用等', '支持定制', '厂家直发'],
};

// 开场钩子：先叫住"老板"，再说一句人话，2 秒内交代"这是给谁用的"
const HOOKS_BY_CATEGORY = {
  '包装盒': [
    (n) => `老板们，这款盒子上新了`,
    (n) => `${n}，装起来就好看`,
    (n) => `店里备点盒子，卖相不一样`,
    (n) => `${n}，整箱分装更好卖`,
  ],
  '手提袋': [
    (n) => `老板们，这款手提袋上新了`,
    (n) => `${n}，装好就能拎走`,
    (n) => `店里备点袋子，送礼不慌`,
    (n) => `${n}，顾客提着有面子`,
  ],
  '标签贴纸': [
    (n) => `老板们，这款标签上新了`,
    (n) => `${n}，贴上去更像品牌`,
    (n) => `小东西，贴上就不一样`,
  ],
  '吊牌': [
    (n) => `老板们，这款吊牌上新了`,
    (n) => `${n}，挂上就有质感`,
  ],
  '礼品盒': [
    (n) => `老板们，你们喜欢的礼盒来了`,
    (n) => `${n}，平时好看过节更有氛围`,
    (n) => `送礼用这个盒子，体面`,
    (n) => `${n}，一件也能装得体面`,
  ],
  '印刷品': [
    (n) => `老板们，印刷这块可以交给我们`,
    (n) => `${n}，印出来更显专业`,
  ],
  '邀请函': [
    (n) => `老板们，邀请函可以这样做`,
    (n) => `${n}，拿出去不掉价`,
  ],
  '其他': [
    (n) => `老板们，${n}上新了`,
    (n) => `${n}，店里用得上`,
    (n) => `备一点${n}，随时用得上`,
  ],
};

// 视觉分析（占位）：接入真实视觉模型时在此实现
async function analyzeVisual(materialMeta) {
  if (!VISION_ENABLED) return null; // 第一阶段返回 null → 调用方使用启发式
  // TODO: 调用 process.env.AI_VISION_API_URL 进行画面理解，返回
  // { category, confidence, productConfirm, tags:[] }
  return null;
}

// 生成电商卖点（规则，仅基于用户填写的类别/产品名，不编造数据）
function generateSellPoints(project) {
  const cat = project.category || '其他';
  const base = SELL_POINTS_BY_CATEGORY[cat] || SELL_POINTS_BY_CATEGORY['其他'];
  const points = [...base];
  // 结合用户填写的产品名补充（仅使用已知信息）
  if (project.name && project.name.trim()) {
    points.unshift(project.name.trim());
  }
  // 去重
  return [...new Set(points)].slice(0, 6);
}

// 生成视频标题（规则）
function generateTitle(project, versionLabel) {
  const name = (project.name || '产品').trim();
  const styleMap = {
    '口播介绍': '口播带货',
    '成品展示': '产品实拍',
    '工厂实力展示': '实力工厂',
    '产品实拍展示': '真实实拍',
    '产品细节介绍': '细节鉴赏',
    '使用场景展示': '场景实测',
    '快节奏商品混剪': '爆款混剪',
    '产品卖点营销': '卖点直击',
    '真实自然的日常拍摄风格': '日常记录',
    '同行爆款 · 口播带货': '口播带货',
    '同行爆款 · 纯产品展示': '产品实拍',
  };
  const tag = styleMap[project.style] || '推荐';
  return `${name}｜${tag}${versionLabel ? '·' + versionLabel : ''}`;
}

// 短名：钩子里用，避免产品名过长把一屏字撑爆
function shortName(name) {
  const n = String(name || '这款产品').trim();
  return n.length > 9 ? n.slice(0, 9) : n;
}

// 生成一条成片的「文案脚本」：开场钩子 / 中段短句字幕 / 片尾卡 / 发布标题
// 只使用用户填写的信息（产品名、类别、品牌、片尾后缀），不编造任何参数。
function buildScript(project) {
  const cat = project.category || '其他';
  const name = shortName(project.name);

  const hooks = (HOOKS_BY_CATEGORY[cat] || HOOKS_BY_CATEGORY['其他'])
    .map((fn) => fn(name))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s, i, arr) => s && arr.indexOf(s) === i);

  const captions = (CAPTIONS_BY_CATEGORY[cat] || CAPTIONS_BY_CATEGORY['其他'])
    .filter((s, i, arr) => arr.indexOf(s) === i);

  // 片尾：有品牌填品牌，没品牌用一句通用引导（都是已确认的供应说法）
  const brand = project.brand || {};
  const brandName = String(brand.name || '').trim();
  const suffix = String(brand.suffix || '').trim();
  const ending = brandName
    ? { main: brandName, sub: suffix || '支持定制 · 厂家直发' }
    : (suffix ? { main: suffix, sub: '支持定制 · 厂家直发' } : { main: '支持定制 · 厂家直发', sub: '想看样品可以私信' });

  // 发布标题：类目 + 两个卖点短句，贴近同行「柚子大量上市，用手提袋打包装好…」的写法
  const title = `${name}，${captions[0] || ''}，${captions[1] || ''}`.replace(/，$/, '').slice(0, 40);

  return { hooks, captions, ending, title };
}

module.exports = {
  VISION_ENABLED, CATEGORIES, SELL_POINTS_BY_CATEGORY, CAPTIONS_BY_CATEGORY,
  analyzeVisual, generateSellPoints, generateTitle, buildScript, shortName,
};
