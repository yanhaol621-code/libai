// auth.js - 账号体系：用户存储、密码哈希(scrypt)、HMAC 会话令牌、权限中间件
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const config = require('../config');

const USERS_FILE = path.join(config.DIRS.data, 'users.json');
const SECRET_FILE = path.join(config.DIRS.data, '.session-secret');
const TOKEN_DAYS = 7;

// 主账号初始信息（首次启动自动创建；已存在则不覆盖）
const DEFAULT_OWNER = {
  id: 'usr_owner',
  username: '李白',
  account: '15954896689',
  password: '789215',
  role: 'owner',
};

// ---------- 职级体系 ----------
// 两条**独立**通道，一个人可以同时拥有：
//   level        专业职级 P0-P8
//   manageLevel  管理层   M1-M4（为空表示不带管理岗）
// 例如「M2 兼 P7」。两条通道各自比较 rank，互不换算。
// 谁能调整：主账号可调全部；管理岗只能调整「不高于自己」的同通道职级。
const LEVELS = [
  { code: 'P0', name: '实习', rank: 0, group: 'P', desc: '实习期，跟做熟悉流程' },
  { code: 'P1', name: '助理', rank: 1, group: 'P', desc: '新入组，跟做执行' },
  { code: 'P2', name: '初级', rank: 2, group: 'P', desc: '可独立完成常规剪辑' },
  { code: 'P3', name: '中级', rank: 3, group: 'P', desc: '稳定产出，懂品类打法' },
  { code: 'P4', name: '高级', rank: 4, group: 'P', desc: '独立带项目，能改脚本' },
  { code: 'P5', name: '资深', rank: 5, group: 'P', desc: '爆款方法论沉淀者' },
  { code: 'P6', name: '专家', rank: 6, group: 'P', desc: '跨品类内容专家' },
  { code: 'P7', name: '高级专家', rank: 7, group: 'P', desc: '定义内容标准与模板' },
  { code: 'P8', name: '首席', rank: 8, group: 'P', desc: '内容方向最终决策者' },
  { code: 'M1', name: '主管', rank: 1, group: 'M', desc: '带 3-5 人小组，管日更节奏' },
  { code: 'M2', name: '经理', rank: 2, group: 'M', desc: '管一条业务线，负责产能' },
  { code: 'M3', name: '总监', rank: 3, group: 'M', desc: '管多个小组，定人效目标' },
  { code: 'M4', name: '总经理', rank: 4, group: 'M', desc: '全盘经营，最高管理岗' },
];
const LEVEL_MAP = new Map(LEVELS.map((l) => [l.code, l]));
const PROFESSIONAL_LEVELS = LEVELS.filter((l) => l.group === 'P');
const MANAGEMENT_LEVELS = LEVELS.filter((l) => l.group === 'M');
const DEFAULT_LEVEL = { owner: { level: null, manageLevel: 'M4' }, operator: { level: 'P1', manageLevel: null } };

function normalizeLevel(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  return LEVEL_MAP.has(c) ? c : null;
}
function normalizeProfessional(code) {
  const c = normalizeLevel(code);
  return c && LEVEL_MAP.get(c).group === 'P' ? c : null;
}
function normalizeManagement(code) {
  const c = normalizeLevel(code);
  return c && LEVEL_MAP.get(c).group === 'M' ? c : null;
}

function defaultLevelFor(role) {
  return (role === 'owner' ? DEFAULT_LEVEL.owner : DEFAULT_LEVEL.operator).level;
}

// 专业职级（P0-P8），未定级返回 null
function levelOf(user) {
  if (!user) return null;
  return normalizeProfessional(user.level);
}

// 管理层（M1-M4），不带管理岗返回 null
function manageLevelOf(user) {
  if (!user) return null;
  return normalizeManagement(user.manageLevel);
}

function levelInfo(code) {
  const c = normalizeLevel(code);
  if (!c) return null;
  const l = LEVEL_MAP.get(c);
  return { code: l.code, name: l.name, rank: l.rank, group: l.group, desc: l.desc };
}

function levelRank(code) {
  const info = levelInfo(code);
  // P0 的 rank 就是 0，所以非法职级用 -1 区分
  return info ? info.rank : -1;
}

// 某人在某通道的 rank：-1 表示这一条没有职级
function rankOf(user, group) {
  const code = group === 'M' ? manageLevelOf(user) : levelOf(user);
  return code ? levelRank(code) : -1;
}

// 管理岗：主账号恒为管理岗；其他账号看是否有管理职级（M1-M4）
function isManager(user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return !!manageLevelOf(user);
}

// 谁能给别人分配职级：主账号 + M 岗
function canAssignLevel(user) {
  return !!user && (user.role === 'owner' || isManager(user));
}

// 可以被 actor 分配的专业职级清单
function assignableLevels(user) {
  if (!user) return [];
  if (user.role === 'owner') return PROFESSIONAL_LEVELS.map((l) => l.code);
  if (!isManager(user)) return [];
  const top = rankOf(user, 'P');
  if (top < 0) return [];
  return PROFESSIONAL_LEVELS.filter((l) => l.rank <= top).map((l) => l.code);
}

// 可以被 actor 分配的管理层清单
function assignableManageLevels(user) {
  if (!user) return [];
  if (user.role === 'owner') return MANAGEMENT_LEVELS.map((l) => l.code);
  if (!isManager(user)) return [];
  const top = rankOf(user, 'M');
  if (top < 0) return [];
  return MANAGEMENT_LEVELS.filter((l) => l.rank <= top).map((l) => l.code);
}

// 「M2 · P7」这样的展示文本（导出、日志用）
function levelText(user) {
  if (!user) return '未定级';
  const m = manageLevelOf(user);
  const p = levelOf(user);
  if (m && p) return m + ' · ' + p;
  return m || p || '未定级';
}

let secretCache = null;

// ---------- 基础读写 ----------
async function ensureDataDir() {
  await fs.mkdir(config.DIRS.data, { recursive: true });
}

async function getSecret() {
  if (secretCache) return secretCache;
  await ensureDataDir();
  try {
    secretCache = (await fs.readFile(SECRET_FILE, 'utf8')).trim();
    if (secretCache.length >= 32) return secretCache;
  } catch (_) { /* 首次生成 */ }
  secretCache = crypto.randomBytes(32).toString('hex');
  await fs.writeFile(SECRET_FILE, secretCache, 'utf8');
  return secretCache;
}

async function loadDb() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8');
    const db = JSON.parse(raw);
    if (!Array.isArray(db.users)) db.users = [];
    return db;
  } catch (_) {
    return { users: [] };
  }
}

async function saveDb(db) {
  await ensureDataDir();
  await fs.writeFile(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
  return db;
}

// 所有对 users.json 的读-改-写都必须走这里串行执行。
// 否则「记录最近在线时间」这类后台写会把旧快照写回去，覆盖掉并发的建号 / 删号 / 改职级。
let writeChain = Promise.resolve();
function withDbWrite(mutator) {
  const run = async () => {
    const db = await loadDb();
    const out = await mutator(db);
    await saveDb(db);
    return out;
  };
  const task = writeChain.then(run, run);
  writeChain = task.then(() => {}, () => {});   // 失败不阻塞后续写入
  return task;
}

// ---------- 密码 ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makePasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${hashPassword(password, salt)}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  const calc = hashPassword(password, salt);
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- 权限 ----------
// 子账号默认为「仅自己」：只能看到自己名下的项目、自己今日生成的视频与自己进行中的任务。
// viewAllVideos 由主账号按人单独授权：可在「今日视频」聚合页看到全部成员的成品视频（只读播放/下载）。
const DEFAULT_PERMISSIONS = { viewAllVideos: false };

function normalizePermissions(u) {
  if (!u) return { viewAllVideos: false };
  if (u.role === 'owner') return { viewAllVideos: true }; // 主账号始终拥有全部权限
  const p = u.permissions || {};
  const out = Object.assign({}, DEFAULT_PERMISSIONS);
  for (const k of Object.keys(DEFAULT_PERMISSIONS)) {
    if (p[k] !== undefined) out[k] = !!p[k];
  }
  return out;
}

// 该账号能否查看「全部成员」的视频（主账号恒为 true）
function canViewAllVideos(user) {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return !!normalizePermissions(user).viewAllVideos;
}

// ---------- 输出脱敏 ----------
function avatarUrlOf(u) {
  if (!u || !u.avatar) return null;
  return `/api/users/${u.id}/avatar?v=${encodeURIComponent(u.avatarVersion || '0')}`;
}

function publicUser(u) {
  if (!u) return null;
  const permissions = normalizePermissions(u);
  const lv = levelInfo(levelOf(u));          // 专业职级 P
  const mv = levelInfo(manageLevelOf(u));    // 管理层 M
  const manager = u.role === 'owner' || !!mv;
  return {
    id: u.id,
    username: u.username,
    account: u.account,
    role: u.role,
    displayName: u.displayName || u.username,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    createdBy: u.createdBy || null,
    lastLoginAt: u.lastLoginAt || null,
    lastSeenAt: u.lastSeenAt || null,
    // 资料 —— 两条独立通道
    level: lv ? lv.code : null,
    levelName: lv ? lv.name : '',
    levelGroup: 'P',
    levelRank: lv ? lv.rank : -1,
    levelDesc: lv ? lv.desc : '',
    manageLevel: mv ? mv.code : null,
    manageName: mv ? mv.name : '',
    manageRank: mv ? mv.rank : -1,
    manageDesc: mv ? mv.desc : '',
    levelText: levelText(u),
    levelUpdatedAt: u.levelUpdatedAt || null,
    avatarUrl: avatarUrlOf(u),
    avatarVersion: u.avatarVersion || null,
    phone: u.phone || '',
    bio: u.bio || '',
    isManager: manager,
    // 权限
    permissions,
    canViewAllVideos: u.role === 'owner' || permissions.viewAllVideos,
    canAssignLevel: u.role === 'owner' || manager,
    assignableLevels: assignableLevels(u),
    assignableManageLevels: assignableManageLevels(u),
  };
}

// ---------- 启动引导：确保有主账号 + 老项目归属 ----------
async function bootstrap() {
  const db = await loadDb();
  let changed = false;
  let owner = db.users.find((u) => u.role === 'owner');
  if (!owner) {
    owner = {
      id: DEFAULT_OWNER.id,
      username: DEFAULT_OWNER.username,
      displayName: DEFAULT_OWNER.username,
      account: DEFAULT_OWNER.account,
      password: makePasswordHash(DEFAULT_OWNER.password),
      role: 'owner',
      disabled: false,
      level: DEFAULT_LEVEL.owner.level,
      manageLevel: DEFAULT_LEVEL.owner.manageLevel,
      createdAt: new Date().toISOString(),
      createdBy: null,
    };
    db.users.unshift(owner);
    changed = true;
  }

  // 老数据补齐权限字段（默认：仅自己）与职级字段。
  // 旧版只有一个 level（可能是 P 也可能是 M）：M 开头的搬到 manageLevel，
  // 专业职级留空由本人在「团队管理」里自己定。
  for (const u of db.users) {
    const old = String(u.level || '').trim().toUpperCase();
    if (old.startsWith('M') && normalizeManagement(old)) {
      if (!normalizeManagement(u.manageLevel)) { u.manageLevel = old; changed = true; }
      u.level = null;
      changed = true;
    } else if (old && !normalizeProfessional(old)) {
      u.level = null;
      changed = true;
    }
    if (u.manageLevel && !normalizeManagement(u.manageLevel)) {
      u.manageLevel = null;
      changed = true;
    }
    if (u.manageLevel === undefined) { u.manageLevel = null; changed = true; }

    if (u.role === 'owner') {
      if (!normalizeManagement(u.manageLevel)) {
        u.manageLevel = DEFAULT_LEVEL.owner.manageLevel;   // 主账号默认 M4
        changed = true;
      }
      continue;
    }
    if (!u.permissions || typeof u.permissions !== 'object') {
      u.permissions = Object.assign({}, DEFAULT_PERMISSIONS);
      changed = true;
    }
    if (!normalizeProfessional(u.level)) {
      u.level = DEFAULT_LEVEL.operator.level;             // 子账号默认 P1
      changed = true;
    }
  }
  if (changed) await saveDb(db);

  // 历史项目没有 ownerId 的，统一归到主账号名下
  try {
    const entries = await fs.readdir(config.DIRS.projects);
    for (const e of entries) {
      const file = path.join(config.DIRS.projects, e, 'project.json');
      let proj;
      try { proj = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { continue; }
      if (!proj.ownerId) {
        proj.ownerId = owner.id;
        try { await fs.writeFile(file, JSON.stringify(proj, null, 2), 'utf8'); } catch (_) {}
      }
    }
  } catch (_) { /* 无项目目录 */ }

  return { owner: publicUser(owner), userCount: db.users.length };
}

// ---------- 登录与用户管理 ----------
async function login(account, password) {
  const key = String(account || '').trim();
  const found = await withDbWrite(async (db) => {
    const user = db.users.find((u) => u.account === key || u.username === key);
    if (!user) return { error: '账号或密码不正确' };
    if (user.disabled) return { error: '该账号已被停用，请联系主账号' };
    if (!verifyPassword(password, user.password)) return { error: '账号或密码不正确' };
    user.lastLoginAt = new Date().toISOString();
    return { user };
  });
  if (found.error) return { error: found.error };
  const token = await signToken(found.user); // 注意：signToken 为异步（读取密钥）
  return { user: publicUser(found.user), token };
}

// 记录「最近在线时间」：只更新单个字段，走统一写队列，避免覆盖并发的建号/删号/改职级
function touchSeen(id, iso) {
  const at = iso || new Date().toISOString();
  return withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) return false;
    u.lastSeenAt = at;
    return true;
  });
}

// 返回原始用户记录（含密码哈希等），仅供内部模块使用
async function getRawUserById(id) {
  const db = await loadDb();
  return db.users.find((u) => u.id === id) || null;
}

async function listRawUsers() {
  const db = await loadDb();
  return db.users.slice();
}

async function getUserById(id) {
  const db = await loadDb();
  return publicUser(db.users.find((u) => u.id === id));
}

async function getUserMap() {
  const db = await loadDb();
  const map = {};
  db.users.forEach((u) => { map[u.id] = u.displayName || u.username; });
  return map;
}

async function listUsers() {
  const db = await loadDb();
  return db.users
    .slice()
    .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : (a.createdAt || '').localeCompare(b.createdAt || '')))
    .map(publicUser);
}

async function createUser({ username, account, password, displayName, createdBy, permissions, level, manageLevel }) {
  const name = String(username || '').trim();
  const acc = String(account || '').trim();
  const pwd = String(password || '');
  if (!name) throw new Error('请填写姓名/昵称');
  if (!acc) throw new Error('请填写登录账号');
  if (!/^[A-Za-z0-9_@.\-]{4,32}$/.test(acc)) throw new Error('登录账号需 4-32 位，仅支持字母、数字、下划线、@ . -');
  if (pwd.length < 6) throw new Error('密码至少 6 位');
  if (level != null && String(level).trim() !== '' && !normalizeProfessional(level)) throw new Error('专业职级不存在（只接受 P0-P8）');
  if (manageLevel != null && String(manageLevel).trim() !== '' && !normalizeManagement(manageLevel)) throw new Error('管理层不存在（只接受 M1-M4）');
  const lv = normalizeProfessional(level) || DEFAULT_LEVEL.operator.level;
  const mv = normalizeManagement(manageLevel) || null;

  const perms = Object.assign({}, DEFAULT_PERMISSIONS);
  if (permissions && typeof permissions === 'object' && permissions.viewAllVideos !== undefined) {
    perms.viewAllVideos = !!permissions.viewAllVideos;
  }

  const user = await withDbWrite(async (db) => {
    if (db.users.some((u) => u.account.toLowerCase() === acc.toLowerCase())) throw new Error('该登录账号已被使用');
    if (db.users.some((u) => u.username === name || (u.displayName || u.username) === name)) throw new Error('该昵称已被使用');
    const row = {
      id: 'usr_' + crypto.randomBytes(6).toString('hex'),
      username: name,
      displayName: displayName || name,
      account: acc,
      password: makePasswordHash(pwd),
      role: 'operator',
      disabled: false,
      level: lv,
      manageLevel: mv,
      permissions: perms,
      createdAt: new Date().toISOString(),
      createdBy: createdBy || null,
    };
    db.users.push(row);
    return row;
  });
  return publicUser(user);
}

// 资料字段（昵称 / 手机号 / 签名）：本人与主账号都走同一套校验
function applyProfilePatch(db, user, patch) {
  if (patch.displayName !== undefined) {
    const n = String(patch.displayName || '').trim();
    if (!n) throw new Error('昵称不能为空');
    if ([...n].length > 16) throw new Error('昵称最多 16 个字');
    if (db.users.some((u) => u.id !== user.id && (u.displayName || u.username) === n)) {
      throw new Error('该昵称已被使用，换一个吧');
    }
    user.displayName = n;
  }
  if (patch.phone !== undefined) {
    const p = String(patch.phone || '').replace(/\s+/g, '');
    if (p && !/^[0-9+\-]{5,20}$/.test(p)) throw new Error('手机号格式不正确');
    user.phone = p;
  }
  if (patch.bio !== undefined) {
    const b = String(patch.bio || '').trim();
    if ([...b].length > 60) throw new Error('个人签名最多 60 个字');
    user.bio = b;
  }
}

// 本人编辑资料（登录账号 / 用户名不可更改）
async function updateProfile(id, patch) {
  const user = await withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('账号不存在');
    applyProfilePatch(db, u, patch || {});
    return u;
  });
  return publicUser(user);
}

async function updateUser(id, patch) {
  const user = await withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('账号不存在');
    if (u.role === 'owner' && (patch.disabled !== undefined || patch.role)) {
      throw new Error('主账号不可停用或改角色');
    }
    if (patch.username !== undefined && String(patch.username).trim() !== u.username) {
      throw new Error('用户名不可更改');
    }
    applyProfilePatch(db, u, patch);
    if (patch.disabled !== undefined) u.disabled = !!patch.disabled;
    // 权限：仅主账号可改子账号；主账号本身恒有全部权限
    const permPatch = patch.permissions && typeof patch.permissions === 'object' ? patch.permissions : null;
    if (permPatch || patch.viewAllVideos !== undefined) {
      if (u.role === 'owner') throw new Error('主账号默认拥有全部权限，无需单独设置');
      const next = normalizePermissions(u);
      if (patch.viewAllVideos !== undefined) next.viewAllVideos = !!patch.viewAllVideos;
      if (permPatch) {
        for (const k of Object.keys(DEFAULT_PERMISSIONS)) {
          if (permPatch[k] !== undefined) next[k] = !!permPatch[k];
        }
      }
      u.permissions = next;
    }
    if (patch.password) {
      if (String(patch.password).length < 6) throw new Error('密码至少 6 位');
      u.password = makePasswordHash(patch.password);
    }
    return u;
  });
  return publicUser(user);
}

async function deleteUser(id) {
  const user = await withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('账号不存在');
    if (u.role === 'owner') throw new Error('主账号不可删除');
    db.users = db.users.filter((x) => x.id !== id);
    return u;
  });
  return publicUser(user);
}

// ---------- 职级分配 ----------
// 两条通道分别判断，互不换算：
//   kind='level'       专业职级 P0-P8（可设为空 = 未定级）
//   kind='manageLevel' 管理层   M1-M4（可设为空 = 不带管理岗）
// 规则：主账号可改任何人的任一条（含自己）；管理岗只能在自己的同通道职级之内调整，
// 且不能调整职级高于自己的成员、不能调整自己的职级（防自我提级）。
const KIND_META = {
  level: { label: '专业职级', field: 'level', group: 'P', normalize: normalizeProfessional },
  manageLevel: { label: '管理层', field: 'manageLevel', group: 'M', normalize: normalizeManagement },
};

async function applyLevelChange(actorId, targetId, kind, raw) {
  const meta = KIND_META[kind];
  if (!meta) throw new Error('未知的职级类型');
  // 空值表示「未定级 / 不带管理岗」
  const isEmpty = raw === null || raw === undefined || String(raw).trim() === '' || String(raw).trim() === '-';
  const next = isEmpty ? null : meta.normalize(raw);
  if (!isEmpty && !next) throw new Error(`${meta.label}不存在`);

  return withDbWrite(async (db) => {
    const actor = db.users.find((u) => u.id === actorId);
    const target = db.users.find((u) => u.id === targetId);
    if (!actor) throw new Error('操作账号不存在');
    if (!target) throw new Error('成员不存在');
    if (!canAssignLevel(actor)) throw new Error('只有主账号与管理岗可以分配职级');
    // 主账号的职级只有主账号本人能调（管理岗无权动）
    if (target.role === 'owner' && actor.id !== target.id) throw new Error('主账号的职级只能由主账号本人调整');
    // 除主账号外，任何人不能给自己调级（防自我提级）
    if (actor.id === target.id && actor.role !== 'owner') throw new Error('不能调整自己的职级');

    if (actor.role !== 'owner') {
      const cap = rankOf(actor, meta.group);           // 操作者在该通道的上限，-1 = 自己没有
      if (cap < 0) throw new Error(`你自己没有${meta.label}，无法调整他人的${meta.label}`);
      const nextRank = next ? levelRank(next) : -1;
      if (nextRank > cap) {
        const mine = meta.group === 'M' ? manageLevelOf(actor) : levelOf(actor);
        throw new Error(`你只能分配不高于自己（${mine}）的${meta.label}`);
      }
      const curRank = rankOf(target, meta.group);
      if (curRank > cap) throw new Error(`该成员的${meta.label}高于你，无权调整`);
    }

    const before = kind === 'level' ? levelOf(target) : manageLevelOf(target);
    if ((before || null) === (next || null)) {
      return { user: publicUser(target), before, after: next, changed: false, kind };
    }
    target[meta.field] = next;
    target.levelUpdatedAt = new Date().toISOString();
    target.levelUpdatedBy = actor.id;
    return { user: publicUser(target), before, after: next, changed: true, kind };
  });
}

// 专业职级（P0-P8）
function setLevel(actorId, targetId, code) {
  return applyLevelChange(actorId, targetId, 'level', code);
}

// 管理层（M1-M4）
function setManageLevel(actorId, targetId, code) {
  return applyLevelChange(actorId, targetId, 'manageLevel', code);
}

// 团队管理（团队概览 + 分配职级）权限：主账号 + M 岗
function canManageTeam(user) {
  return !!user && (user.role === 'owner' || isManager(user));
}

// ---------- 头像 ----------
async function setAvatar(id, filename, version) {
  const user = await withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('账号不存在');
    u.avatar = filename;
    u.avatarVersion = String(version || Date.now());
    return u;
  });
  return publicUser(user);
}

async function clearAvatar(id) {
  const user = await withDbWrite(async (db) => {
    const u = db.users.find((x) => x.id === id);
    if (!u) throw new Error('账号不存在');
    u.avatar = null;
    u.avatarVersion = null;
    return u;
  });
  return publicUser(user);
}

// ---------- 会话令牌 ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function signToken(user) {
  const secret = await getSecret();
  const payload = { uid: user.id, role: user.role, exp: Date.now() + TOKEN_DAYS * 864e5 };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

async function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const secret = await getSecret();
  const expect = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(sig || '', 'hex');
  const b = Buffer.from(expect, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body)); } catch (_) { return null; }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

// ---------- 中间件 ----------
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

async function middleware(req, res, next) {
  const url = req.path;
  if (!url.startsWith('/api/')) return next();          // 静态页面本身不拦，页面内跳登录
  if (url === '/api/health' || url === '/api/auth/login') return next();
  const token = readCookie(req, 'sid') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = await verifyToken(token);
  if (!payload) return res.status(401).json({ error: '未登录或登录已过期' });
  const user = await getUserById(payload.uid);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  if (user.disabled) return res.status(401).json({ error: '账号已被停用' });
  req.user = user;
  next();
}

function ownerOnly(req, res, next) {
  if (!req.user || req.user.role !== 'owner') return res.status(403).json({ error: '仅主账号可访问' });
  next();
}

// 团队概览 / 分配职级：主账号 + M 岗
function teamOnly(req, res, next) {
  if (!canManageTeam(req.user)) return res.status(403).json({ error: '仅主账号与管理岗可访问' });
  next();
}

// 项目访问权：主账号可访问全部；子账号仅限自己名下
function canAccessProject(user, project) {
  if (!user || !project) return false;
  if (user.role === 'owner') return true;
  return project.ownerId === user.id;
}

// 只读媒体访问权：被授权「查看全部视频」的子账号，可播放/下载他人项目的成品视频
function canReadProjectMedia(user, project) {
  if (canAccessProject(user, project)) return true;
  return canViewAllVideos(user);
}

const TOKEN_MAX_AGE = TOKEN_DAYS * 86400;

module.exports = {
  bootstrap, login, createUser, updateUser, deleteUser,
  listUsers, getUserById, getUserMap, publicUser,
  getRawUserById, listRawUsers, touchSeen,
  updateProfile, setLevel, setManageLevel, setAvatar, clearAvatar,
  signToken, verifyToken, middleware, ownerOnly, teamOnly, canAccessProject,
  canViewAllVideos, canReadProjectMedia, normalizePermissions, DEFAULT_PERMISSIONS,
  LEVELS, PROFESSIONAL_LEVELS, MANAGEMENT_LEVELS,
  normalizeLevel, normalizeProfessional, normalizeManagement,
  levelInfo, levelOf, manageLevelOf, levelRank, levelText, rankOf, isManager,
  canAssignLevel, assignableLevels, assignableManageLevels, canManageTeam,
  readCookie, TOKEN_MAX_AGE,
};
