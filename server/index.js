// index.js - 主服务器：静态资源 + REST API + SSE
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const archiver = require('archiver');
const config = require('./config');
const store = require('./lib/store');
const analysis = require('./lib/analysis');
const inspect = require('./lib/inspect');
const asr = require('./lib/asr');
const music = require('./lib/music');
const tasks = require('./lib/tasks');
const ai = require('./lib/ai');
const templates = require('./lib/templates');
const auth = require('./lib/auth');
const ffmpeg = require('./lib/ffmpeg');
const presence = require('./lib/presence');
const chat = require('./lib/chat');

config.ensureDirs();
// 预载字体路径（触发复制）
const render = require('./lib/render');
try { render.ensureFont(); } catch (_) {}

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

const app = express();
app.use(express.json({ limit: '5mb' }));
// 设置页已下线（改密码合并进「我的资料」）：旧链接统一跳过去，避免收藏夹打开是 404
app.get('/settings.html', (req, res) => res.redirect(302, '/profile.html'));
app.use(express.static(path.join(config.ROOT, 'public')));
// 鉴权：仅拦截 /api/*，静态页面由前端跳转登录
app.use(auth.middleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });
// 头像上传：单独限流，只收图片
const avatarUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
function avatarMw(req, res, next) {
  avatarUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '图片不要超过 8MB' : '上传失败：' + err.message;
    return res.status(400).json({ error: msg });
  });
}

// 聊天附件：直接落盘到 data/chat/files，避免大文件占内存
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.DIRS.chatFiles),
  filename: (req, file, cb) => cb(null, 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
});
const chatUpload = multer({ storage: chatStorage, limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
function chatMw(req, res, next) {
  chatUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '附件不要超过 100MB' : '上传失败：' + err.message;
    return res.status(400).json({ error: msg });
  });
}

// 上传会话（分片）
const uploadSessions = {};

// 启动时确保主账号存在（李白 / 15954896689），并把历史项目归到主账号
auth.bootstrap().then((r) => {
  console.log('[auth] 主账号就绪:', r.owner.account, '| 用户数:', r.userCount);
}).catch((e) => console.error('[auth] 初始化失败:', e.message));

// ===== 会话 =====
app.post('/api/auth/login', async (req, res) => {
  try {
    const { account, password } = req.body || {};
    if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });
    const r = await auth.login(account, password);
    if (r.error) return res.status(401).json({ error: r.error });
    res.setHeader('Set-Cookie',
      `sid=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${auth.TOKEN_MAX_AGE}`);
    presence.markLogin(r.user.id);   // 登录即在线
    res.json({ ok: true, user: r.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.user && req.user.id) presence.markOffline(req.user.id);
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    const check = await auth.login(req.user.account, oldPassword);
    if (check.error) return res.status(400).json({ error: '原密码不正确' });
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    await auth.updateUser(req.user.id, { password: newPassword });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 我的资料（本人可编辑：头像、昵称、手机号、签名）=====
// 登录账号与用户名不可更改，保证团队沟通时认得出是谁
app.patch('/api/auth/profile', async (req, res) => {
  try {
    const { displayName, phone, bio } = req.body || {};
    const user = await auth.updateProfile(req.user.id, { displayName, phone, bio });
    res.json(user);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 头像上传：统一裁成方形 240x240 WebP，省流量、各端一致
app.post('/api/auth/avatar', avatarMw, async (req, res) => {
  const tmp = path.join(config.DIRS.temp, `av_${req.user.id}_${Date.now()}`);
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: '请选择一张图片' });
    if (!/^image\//i.test(f.mimetype || '')) return res.status(400).json({ error: '只支持图片文件（JPG / PNG / WebP）' });
    await fs.mkdir(config.DIRS.temp, { recursive: true });
    await fs.writeFile(tmp, f.buffer);
    await fs.mkdir(config.DIRS.avatars, { recursive: true });
    const name = `${req.user.id}.webp`;
    const out = path.join(config.DIRS.avatars, name);
    const r = await ffmpeg.run(config.FFMPEG_PATH, [
      '-y', '-i', tmp,
      '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=240:240:flags=lanczos",
      '-frames:v', '1', '-c:v', 'libwebp', '-quality', '88', out,
    ], { timeout: 30000 });
    if (r.code !== 0) return res.status(400).json({ error: '图片解析失败，换一张 JPG / PNG 试试' });
    const user = await auth.setAvatar(req.user.id, name, Date.now());
    res.json({ ok: true, user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
});

app.delete('/api/auth/avatar', async (req, res) => {
  try {
    const avFile = path.join(config.DIRS.avatars, req.user.id + '.webp');
    let lastErr = null;
    // Windows 上刚被 ffmpeg 写入的文件可能短暂被占用，重试几次而不是静默失败
    for (let i = 0; i < 5; i++) {
      try { await fs.unlink(avFile); lastErr = null; break; }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 120)); }
    }
    if (lastErr) console.error('[avatar] 删除头像文件失败', lastErr.code, lastErr.message);
    res.json({ ok: true, user: await auth.clearAvatar(req.user.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 头像读取（登录后可见；URL 带 ?v= 版本号，更新后立即刷新）
app.get('/api/users/:uid/avatar', (req, res) => {
  const uid = String(req.params.uid || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!uid) return res.status(404).end();
  const file = path.join(config.DIRS.avatars, uid + '.webp');
  if (!fsSync.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(file);
});

// ===== 职级（专业职级 P0-P8 与 管理层 M1-M4 两条独立通道） =====
app.get('/api/team/levels', (req, res) => {
  res.json({
    levels: auth.LEVELS,                          // 全量（兼容旧前端）
    professional: auth.PROFESSIONAL_LEVELS,       // P0-P8
    management: auth.MANAGEMENT_LEVELS,           // M1-M4
    canAssign: auth.canAssignLevel(req.user),
    assignable: auth.assignableLevels(req.user),
    assignableManage: auth.assignableManageLevels(req.user),
  });
});

// ===== 团队管理（主账号 + 管理岗 M1-M4） =====
app.get('/api/team/overview', auth.teamOnly, async (req, res) => {
  try {
    const users = await auth.listUsers();
    const rows = [];
    for (const u of users) {
      const scope = u.role === 'owner' ? null : u;
      const [s, vids, tasksNow] = await Promise.all([
        store.stats(scope),
        store.todayVideos(scope),
        store.runningTasks(scope),
      ]);
      rows.push({
        user: u,
        stats: s,
        todayVideoCount: vids.count,
        runningCount: tasksNow.count,
        runningItems: tasksNow.items,
      });
    }
    res.json({ rows, date: new Date().toISOString().slice(0, 10), levels: auth.LEVELS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/team/users', auth.ownerOnly, async (req, res) => {
  try {
    const u = await auth.createUser(Object.assign({}, req.body, { createdBy: req.user.id }));
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/team/users/:uid', auth.ownerOnly, async (req, res) => {
  try { res.json(await auth.updateUser(req.params.uid, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 分配 / 调整职级：body 里给 level（P0-P8）或 manageLevel（M1-M4，可传 null 取消管理岗）
// 主账号可调全部（含自己）；管理岗只能在自己的同通道职级之内调整
app.patch('/api/team/users/:uid/level', auth.teamOnly, async (req, res) => {
  try {
    const body = req.body || {};
    const out = { ok: true };
    if (body.level !== undefined) Object.assign(out, await auth.setLevel(req.user.id, req.params.uid, body.level));
    if (body.manageLevel !== undefined) Object.assign(out, await auth.setManageLevel(req.user.id, req.params.uid, body.manageLevel));
    if (body.level === undefined && body.manageLevel === undefined) {
      return res.status(400).json({ error: '请提供 level（专业职级）或 manageLevel（管理层）' });
    }
    res.json(out);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/team/users/:uid', auth.ownerOnly, async (req, res) => {
  try {
    // 删除子账号前，把它名下项目转给主账号，避免数据丢失
    const entries = await fs.readdir(config.DIRS.projects).catch(() => []);
    let moved = 0;
    for (const e of entries) {
      let proj;
      try { proj = await store.loadProject(e); } catch (_) { continue; }
      if (proj.ownerId === req.params.uid) {
        proj.ownerId = req.user.id;
        await store.saveProject(proj);
        moved += 1;
      }
    }
    const removed = await auth.deleteUser(req.params.uid);
    await fs.unlink(path.join(config.DIRS.avatars, req.params.uid + '.webp')).catch(() => {});
    await chat.purgeUser(req.params.uid).catch(() => {});   // 一并清掉他的聊天记录与附件
    res.json({ ok: true, removed, movedProjects: moved });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== 管理权限（仅主账号） =====
// 子账号默认「仅自己」；这里按人单独授权「可看全部视频」
app.get('/api/team/permissions', auth.ownerOnly, async (req, res) => {
  try {
    const users = await auth.listUsers();
    const all = await store.todayVideos(null);
    const byOwner = {};
    for (const v of all.items) byOwner[v.ownerId] = (byOwner[v.ownerId] || 0) + 1;
    const rows = users.map((u) => Object.assign({}, u, {
      canViewAllVideos: u.role === 'owner' ? true : !!u.canViewAllVideos,
      todayVideoCount: byOwner[u.id] || 0,
    }));
    res.json({
      date: all.date,
      totalTodayVideos: all.count,
      rows,
      defaults: { operator: { viewAllVideos: false } },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 项目归属校验：主账号可访问全部，子账号仅自己名下；
// 被主账号授权「查看全部视频」的子账号，只能只读获取他人视频的播放/缩略图
app.param('id', async (req, res, next, id) => {
  try {
    const project = await store.loadProject(id);
    if (auth.canAccessProject(req.user, project)) {
      req.project = project;
      return next();
    }
    const mediaOnly = req.method === 'GET' && /\/videos\/[^/]+\/(file|thumb)$/.test(req.path);
    if (mediaOnly && auth.canReadProjectMedia(req.user, project)) {
      req.project = project;
      req.readonly = true;
      return next();
    }
    return res.status(403).json({ error: '无权访问该项目' });
  } catch (_) {
    return res.status(404).json({ error: '项目不存在' });
  }
});

// 主账号可用 ?user=<uid> 查看某个运营名下的数据
function scopedUser(req) {
  const uid = req.query.user;
  if (req.user.role === 'owner' && uid) return { id: uid, role: 'operator' };
  return req.user.role === 'owner' ? null : req.user;
}

// 视频聚合的可见范围：
// 主账号 => 全部（或 ?user= 指定成员）；子账号默认仅自己；被授权「查看全部视频」=> 全部
function videoScope(req) {
  if (req.user.role === 'owner') return req.query.user ? { id: req.query.user, role: 'operator' } : null;
  return auth.canViewAllVideos(req.user) ? null : req.user;
}

function scopeInfo(req) {
  if (req.user.role === 'owner') {
    return { scope: req.query.user ? 'user' : 'all', canViewAllVideos: true };
  }
  const all = auth.canViewAllVideos(req.user);
  return { scope: all ? 'all' : 'mine', canViewAllVideos: all };
}

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ffmpeg: fsSync.existsSync(config.FFMPEG_PATH), ffprobe: fsSync.existsSync(config.FFPROBE_PATH), port: config.PORT });
});

// ===== 项目 =====
app.get('/api/stats', async (req, res) => {
  try { res.json(await store.stats(scopedUser(req))); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects', async (req, res) => {
  try {
    const list = await store.listProjects(scopedUser(req));
    const names = await auth.getUserMap();
    res.json(list.map((p) => Object.assign(p, { ownerName: names[p.ownerId] || '未归属' })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const p = await store.createProject(req.body || {}, req.user.id);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const p = await store.loadProject(req.params.id);
    // 打开项目就顺手把识别模型热起来：运营从打开项目到点「字幕识别」通常有几十秒，
    // 足够跳过 python 导入 + 权重加载的 20 多秒冷启动。失败无所谓，点识别时还会重试。
    try { asr.prewarm({ model: (p.asr && p.asr.model) || undefined }); } catch (_) {}
    res.json(p);
  } catch (e) { res.status(404).json({ error: '项目不存在' }); }
});

// 修改项目参数（类别 / 比例 / 成片模板 / 时长 / 数量 / 品牌片尾 / 字幕开关）
app.patch('/api/projects/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const updated = await store.withLock(req.params.id, async () => {
      const p = await store.loadProject(req.params.id);
      if (body.category !== undefined) p.category = String(body.category).slice(0, 20);
      if (body.ratio !== undefined) {
        const r = String(body.ratio);
        const mm = /^(\d+)\s*:\s*(\d+)$/.exec(r);
        const okCustom = mm && +mm[1] >= 1 && +mm[1] <= 99 && +mm[2] >= 1 && +mm[2] <= 99;
        if (!['9:16', '1:1', '4:3', '16:9'].includes(r) && !okCustom) {
          throw new Error('无效的视频比例（可用 9:16 / 1:1 / 4:3 / 16:9 或自定义 宽:高，如 3:4）');
        }
        p.ratio = r.replace(/\s+/g, '');
      }
      if (body.style !== undefined) {
        if (!templates.STYLE_NAMES.includes(body.style)) throw new Error('未知的视频类型');
        p.style = body.style;
      }
      // 背景音乐风格（系统原创配乐；留空则按项目风格自动匹配）
      if (body.musicPreset !== undefined) {
        if (body.musicPreset && !music.PRESETS[body.musicPreset]) throw new Error('未知的音乐风格');
        p.musicPreset = body.musicPreset || '';
      }
      // 音乐素材库选用（优先级高于项目上传音乐；清空则回退自动匹配）
      if (body.musicLibId !== undefined) p.musicLibId = String(body.musicLibId || '');
      if (body.duration !== undefined) p.duration = Math.max(5, Math.min(300, parseInt(body.duration, 10) || 30));
      if (body.count !== undefined) p.count = Math.max(1, Math.min(30, parseInt(body.count, 10) || 1));
      if (body.brand && typeof body.brand === 'object') {
        const brand = Object.assign({ name: '', logo: '', suffix: '' }, p.brand || {});
        if (body.brand.name !== undefined) brand.name = String(body.brand.name).slice(0, 40);
        if (body.brand.suffix !== undefined) brand.suffix = String(body.brand.suffix).slice(0, 40);
        p.brand = brand;
      }
      if (body.subtitle && typeof body.subtitle === 'object') p.subtitle = Object.assign({}, p.subtitle, body.subtitle);
      p.updatedAt = new Date().toISOString();
      await store.saveProject(p);
      return p;
    });
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try { await store.deleteProject(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 跨项目素材库（聚合检索，按访问权限过滤）
app.get('/api/library', async (req, res) => {
  try {
    const projects = await store.listProjects(scopedUser(req));
    const items = [];
    for (const p of projects) {
      const proj = await store.loadProject(p.id);
      for (const m of proj.materials || []) {
        // 只进「一次修改」完成过的素材：没改完的半成品不往后流
        if (!m.editDone) continue;
        items.push({
          materialId: m.id, projectId: p.id, projectName: p.name,
          originalName: m.originalName, category: m.category, type: m.type,
          duration: m.duration, status: m.status, needsConfirm: m.needsConfirm,
          forbidden: m.forbidden, required: m.required, createdAt: m.createdAt,
          editDone: true,
        });
      }
    }
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 分片上传 =====
app.post('/api/projects/:id/upload/init', async (req, res) => {
  try {
    const { filename, totalChunks, fileSize, mime } = req.body;
    const uploadId = store.newId('up');
    const dir = path.join(config.DIRS.temp, 'upload_' + uploadId);
    await fs.mkdir(dir, { recursive: true });
    uploadSessions[uploadId] = { projectId: req.params.id, filename, totalChunks: +totalChunks, fileSize: +fileSize, mime, dir, received: {} };
    res.json({ uploadId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/upload/chunk', upload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, index } = req.body;
    const sess = uploadSessions[uploadId];
    if (!sess) return res.status(400).json({ error: '上传会话不存在' });
    if (!req.file) return res.status(400).json({ error: '缺少分片' });
    await fs.writeFile(path.join(sess.dir, String(index)), req.file.buffer);
    sess.received[index] = true;
    const receivedCount = Object.keys(sess.received).length;
    res.json({ ok: true, received: receivedCount, total: sess.totalChunks });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 分片组装：边读边写（createReadStream → 同一个写流），不再「整块读进内存再写」，
// 大文件少一次完整的内存往返，速度接近磁盘拷贝速度。
async function concatChunks(dir, totalChunks, target) {
  const out = fsSync.createWriteStream(target);
  const done = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  try {
    for (let i = 0; i < totalChunks; i++) {
      await new Promise((resolve, reject) => {
        const rs = fsSync.createReadStream(path.join(dir, String(i)));
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(out, { end: false });
      });
    }
    out.end();
    await done;
  } catch (e) {
    out.destroy();
    throw e;
  }
}

app.post('/api/projects/:id/upload/finish', async (req, res) => {
  try {
    const { uploadId } = req.body;
    const sess = uploadSessions[uploadId];
    if (!sess) return res.status(400).json({ error: '上传会话不存在' });
    // 校验分片完整性
    for (let i = 0; i < sess.totalChunks; i++) {
      if (!sess.received[i]) return res.status(400).json({ error: `分片 ${i} 缺失` });
    }
    // 组装
    const ext = path.extname(sess.filename) || '';
    const matId = store.newId('mat');
    const safeName = matId + (ext || '.bin');
    const target = path.join(config.materialDir(sess.projectId), safeName);
    await fs.mkdir(config.materialDir(sess.projectId), { recursive: true });
    await concatChunks(sess.dir, sess.totalChunks, target);
    // 清理分片（非致命：清理失败不影响上传结果）
    try { await fs.rm(sess.dir, { recursive: true, force: true }); } catch (_) {}
    delete uploadSessions[uploadId];

    const stat = await fs.stat(target);
    const material = await store.withLock(sess.projectId, async () => {
      const project = await store.loadProject(sess.projectId);
      const m = {
        id: matId, filename: safeName, originalName: sess.filename,
        mime: sess.mime, size: stat.size, status: 'pending',
        type: analysis.isImage(sess.filename) ? 'image' : 'video',
        duration: 0, width: null, height: null, hasAudio: false,
        category: '其他', required: false, forbidden: false,
        usable: true, needsConfirm: true, quality: null, problems: [],
        aiTags: [], createdAt: new Date().toISOString(),
      };
      project.materials.push(m);
      await store.saveProject(project);
      return m;
    });

    // 异步分析
    analyzeAndEmit(sess.projectId, matId);
    res.json({ ok: true, material });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 直传（默认通道）=====
// 整文件一次落盘到 temp，再同盘 rename 进素材目录：只写一次盘、不转码不压缩，
// 落盘内容与浏览器拿到的原始字节完全一致（画质同原素材），大文件也不用等分片往返。
const directStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.DIRS.temp),
  filename: (req, file, cb) => cb(null, 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.part'),
});
const directUpload = multer({ storage: directStorage, limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 } });
function directMw(req, res, next) {
  directUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (req.file && req.file.path) fs.rm(req.file.path, { force: true }).catch(() => {});
    const msg = err.code === 'LIMIT_FILE_SIZE' ? '单个素材不要超过 8GB' : '上传失败：' + err.message;
    return res.status(400).json({ error: msg });
  });
}

app.post('/api/projects/:id/upload/direct', directMw, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '缺少文件' });
  const tmp = req.file.path;
  try {
    const projectId = req.params.id;
    // 中文名走 body 字段（multipart 里的 originalname 在部分浏览器会变乱码）
    const origName = ((req.body && req.body.filename) || req.file.originalname || 'material').toString();
    const ext = (path.extname(origName) || '').toLowerCase();
    const matId = store.newId('mat');
    const safeName = matId + (ext || '.bin');
    const dir = config.materialDir(projectId);
    const target = path.join(dir, safeName);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.rename(tmp, target); // 同一磁盘分区，瞬间完成（不复制、不改字节）
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // 万一 temp 和素材目录不在同一分区：复制后删源（仍然逐字节原样搬运）
      await fs.copyFile(tmp, target);
      await fs.rm(tmp, { force: true });
    }
    const stat = await fs.stat(target);
    const material = await store.withLock(projectId, async () => {
      const project = await store.loadProject(projectId);
      const m = {
        id: matId, filename: safeName, originalName: origName,
        mime: req.file.mimetype || '', size: stat.size, status: 'pending',
        type: analysis.isImage(origName) ? 'image' : 'video',
        duration: 0, width: null, height: null, hasAudio: false,
        category: '其他', required: false, forbidden: false,
        usable: true, needsConfirm: true, quality: null, problems: [],
        aiTags: [], createdAt: new Date().toISOString(),
      };
      project.materials.push(m);
      await store.saveProject(project);
      return m;
    });
    analyzeAndEmit(projectId, matId);
    res.json({ ok: true, material });
  } catch (e) {
    try { await fs.rm(tmp, { force: true }); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

async function analyzeAndEmit(projectId, matId) {
  tasks.emitProject(projectId, { type: 'material', status: 'analyzing', materialId: matId });
  try {
    const mat = await analysis.analyzeMaterial(projectId, matId);
    tasks.emitProject(projectId, { type: 'material', status: 'analyzed', material: mat });
  } catch (e) {
    tasks.emitProject(projectId, { type: 'material', status: 'error', materialId: matId, error: e.message });
  }
}

// ===== 素材操作 =====
// 可选变速档位：只接受这几档，避免前端传来奇怪倍率把时间轴算乱
const SPEED_STEPS = [0.5, 0.8, 1, 1.25, 1.5, 2, 3];
// 素材人工分类（运营在一次修改里手动选）：决定自动混剪里的出场位置
const MAT_PARTS = ['开头', '片尾', '材质', '规格', '讲解'];

// 归一化「多轨截取 + 变速」：3 条画面轨 / 2 条音频轨，片段可以自由摆放、允许跨轨重叠
// （成片按「上层盖下层」合成，重叠由 timeline 解析器决定谁显示）
// 老数据没有 t0/v/a：按原片顺序首尾相接排在第 1 条画面轨上，行为和以前完全一致
function normalizeMatEdit(mat) {
  const dur = Number(mat.duration) || 0;
  const V_LANES = 3, A_LANES = 2;      // 画面轨 V1~V3 / 音频轨 A1~A2
  const MAX_PIECES = 240;
  if (Array.isArray(mat.pieces)) {
    const max = dur > 0 ? dur : Infinity;
    const clip = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? +Math.max(0, Math.min(n, max)).toFixed(2) : NaN;
    };
    const lane = (v, n) => {
      const i = Math.round(Number(v));
      return Number.isFinite(i) ? Math.max(0, Math.min(n - 1, i)) : 0;
    };
    const raw = [];
    for (const p of mat.pieces) {
      if (!p) continue;
      const q = { in: clip(p.in), out: clip(p.out) };
      if (!Number.isFinite(q.in) || !Number.isFinite(q.out) || q.out - q.in <= 0.2) continue;
      q.v = lane(p.v, V_LANES);
      q.a = lane(p.a, A_LANES);
      const t0 = Number(p.t0);
      q.t0 = Number.isFinite(t0) ? +Math.max(0, Math.min(t0, max)).toFixed(2) : null;
      // 声音：默认跟画面同位置同区间；拖过/截过才写自己的时间与区间
      const aIn = clip(p.aIn), aOut = clip(p.aOut);
      if (Number.isFinite(aIn) && Number.isFinite(aOut) && aOut - aIn > 0.1) {
        q.aIn = aIn;
        q.aOut = aOut;
      }
      const aT0 = Number(p.aT0);
      if (Number.isFinite(aT0)) q.aT0 = +Math.max(0, Math.min(aT0, max)).toFixed(2);
      if (p.aMute) q.aMute = true;
      raw.push(q);
    }
    // 老数据（没有 t0）：按原片时间先后首尾相接——保持「中间截断后自动拼接」的旧行为
    if (raw.some((q) => q.t0 === null)) {
      raw.sort((a, b) => a.in - b.in);
      let cur = 0;
      for (const q of raw) {
        if (q.t0 === null) q.t0 = +cur.toFixed(2);
        cur = q.t0 + (q.out - q.in);
      }
    }
    raw.sort((a, b) => a.t0 - b.t0);
    const kept = raw.slice(0, MAX_PIECES);
    if (kept.length) {
      mat.pieces = kept;
      // 包络区间：给优化/美颜/裁剪等旧逻辑用（覆盖所有片段用到的原片范围）
      mat.trimIn = +Math.min(...kept.map((p) => p.in)).toFixed(2);
      mat.trimOut = +Math.max(...kept.map((p) => p.out)).toFixed(2);
    } else {
      delete mat.pieces; // 全被裁掉了：退回「整段可用」，由前端提示至少保留一段
    }
  }
  if (mat.speed !== undefined) {
    const s = Number(mat.speed);
    mat.speed = SPEED_STEPS.includes(s) ? s : 1;
  }
  if (mat.volume !== undefined) {
    const v = Number(mat.volume);
    mat.volume = Number.isFinite(v) ? +Math.max(0, Math.min(2, v)).toFixed(2) : 1;
  }
  if (mat.muted !== undefined) mat.muted = !!mat.muted;
  // 一次修改完成：只有完成过的素材才会进入「一键美颜 / 字幕识别 / 自动混剪」等后续步骤
  if (mat.editDone !== undefined) {
    mat.editDone = !!mat.editDone;
    if (mat.editDone) {
      if (!mat.editDoneAt) mat.editDoneAt = new Date().toISOString();
    } else {
      delete mat.editDoneAt;
    }
  }
  // 美颜勾选：true = 这条不参与一键美颜；取消勾选就删字段（老数据无此字段视为参与）
  if (mat.beautySkip !== undefined) {
    if (mat.beautySkip) mat.beautySkip = true;
    else delete mat.beautySkip;
  }
  // 素材分类：只接受固定的 5 类，传空/非法值当作「没分类」
  if (mat.part !== undefined) {
    const p = String(mat.part || '').trim();
    if (MAT_PARTS.includes(p)) mat.part = p;
    else delete mat.part;
  }
  // 标记：进度条上任意位置的时间点（只做记录，不影响成片），按时间排序去重
  if (mat.marks !== undefined) {
    const max = dur > 0 ? dur : Infinity;
    const out = [];
    for (const v of Array.isArray(mat.marks) ? mat.marks : []) {
      const t = Number(v);
      if (!Number.isFinite(t)) continue;
      const q = +Math.max(0, Math.min(t, max)).toFixed(2);
      if (out.some((x) => Math.abs(x - q) < 0.08)) continue;
      out.push(q);
      if (out.length >= 100) break;
    }
    if (out.length) mat.marks = out.sort((a, b) => a - b);
    else delete mat.marks;
  }
}

app.patch('/api/projects/:id/materials/:mid', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const mat = project.materials.find((m) => m.id === req.params.mid);
    if (!mat) return res.status(404).json({ error: '素材不存在' });
    const allowed = ['category', 'required', 'forbidden', 'notes', 'usable', 'needsConfirm',
      // 审核页新增：排除（非破坏性，不删文件）/ 必留 / 重点产品镜头 / 裁切点 / 重命名
      'excluded', 'mustKeep', 'keyShot', 'trimIn', 'trimOut', 'name',
      // 一次修改新增：多段截取（中间截断后拼接）/ 变速 / 音频分层（音量、整体静音）
      'pieces', 'speed', 'volume', 'muted',
      // 进度条标记（任意位置的时间点，仅记录不影响成片）
      'marks',
      // 一次修改完成标记（未完成的素材不会出现在后续步骤里）
      'editDone',
      // 美颜勾选（运营在「③ 一键美颜」里逐个勾，true = 不美颜）
      'beautySkip',
      // 人工分类（运营手动选）：开头 / 片尾 / 材质 / 规格 / 讲解，自动混剪按这个决定出场位置
      'part'];
    for (const k of allowed) if (req.body[k] !== undefined) mat[k] = req.body[k];
    normalizeMatEdit(mat);
    await store.saveProject(project);
    res.json(mat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 保存替换原素材：把当前剪辑（片段/变速/音量/静音）烘焙成新视频，替换素材源文件 =====
// 非破坏性：原始文件重命名为 <名>_orig_<时间戳>.bak.mp4 保留在素材目录，可手动恢复；
// 该素材之前的美颜/优化副本是基于旧原片生成的，会与本次手动剪辑冲突，这里一并清掉引用（文件保留）。
app.post('/api/projects/:id/materials/:mid/export-trim', async (req, res) => {
  try {
    const projectId = req.params.id, mid = req.params.mid;
    const project = await store.loadProject(projectId);
    const mat = project.materials.find((m) => m.id === mid);
    if (!mat) return res.status(404).json({ error: '素材不存在' });
    if (mat.type !== 'video') return res.status(400).json({ error: '仅支持视频素材' });

    const matDir = config.materialDir(projectId);
    const origName = mat.filename;
    const ext = path.extname(origName) || '.mp4';
    const stem = origName.slice(0, -ext.length);
    const trimName = `${stem}_trim${ext}`;
    const trimPath = path.join(matDir, trimName);

    const meta = await render.renderMaterialTrim(projectId, mat, trimPath);

    // 1) 原始文件备份（不删）
    const bakName = `${stem}_orig_${Date.now()}${ext}`;
    await safeMove(path.join(matDir, origName), path.join(matDir, bakName))
      .catch(async () => { await fs.copyFile(path.join(matDir, origName), path.join(matDir, bakName)); });
    // 2) 裁剪结果顶替原文件名（替换原素材）
    await safeMove(trimPath, path.join(matDir, origName))
      .catch(async () => { await fs.copyFile(trimPath, path.join(matDir, origName)); await fs.unlink(trimPath).catch(() => {}); });

    // 3) 元数据：剪辑已烘焙进文件，清空可再编辑的片段/速度/音量/静音
    mat.filename = origName;
    mat.width = meta.width; mat.height = meta.height;
    mat.duration = +meta.duration.toFixed(2);
    mat.trimIn = 0; mat.trimOut = +meta.duration.toFixed(2);
    mat.pieces = undefined; mat.speed = 1; mat.muted = false; mat.volume = 1; mat.marks = undefined;
    mat.trimBackup = bakName;            // 记录原始备份，便于回退
    mat.optimized = undefined; mat.beauty = undefined;  // 旧优化/美颜副本基于旧原片，与新剪辑冲突，清引用（文件保留）
    // 5) 源文件已变成新剪辑：旧字幕识别的时间轴全部作废。不清掉的话「字幕识别」会跳过这条
    //    （list.filter(m => !m.asr || !m.asr.file)），成片里就会烧上对不上画面的旧字幕
    if (mat.asr && mat.asr.file) await fs.unlink(path.join(matDir, mat.asr.file)).catch(() => {});
    delete mat.asr; delete mat.asrCues; delete mat.asrRepeats;
    // 4) 缩略图重建
    await ffmpeg.thumbnail(path.join(matDir, origName), path.join(matDir, 'thumb', mat.id + '.jpg'), Math.min(1, meta.duration * 0.3), 480).catch(() => {});
    mat.thumbnail = 'thumb/' + mat.id + '.jpg';

    await store.saveProject(project);
    tasks.emitProject(projectId, { type: 'material-trimmed', materialId: mid });
    res.json(mat);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 剪切另存素材：把当前剪辑（片段/变速/音量/静音）烘焙成一条全新素材，原素材完全不动 =====
// 长素材可以反复「改截取点 → 另存」拆成多条；新素材走与上传一致的分析流（AI 分类/缩略图），
// 之后在「② 一次修改」里设置人工分类（part）并标记完成，即可参与一键美颜/字幕识别/混剪。
app.post('/api/projects/:id/materials/:mid/save-as', async (req, res) => {
  try {
    const projectId = req.params.id, mid = req.params.mid;
    const project = await store.loadProject(projectId);
    const mat = project.materials.find((m) => m.id === mid);
    if (!mat) return res.status(404).json({ error: '素材不存在' });
    if (mat.type !== 'video') return res.status(400).json({ error: '仅支持视频素材' });

    const matDir = config.materialDir(projectId);
    await fs.mkdir(matDir, { recursive: true });
    const newId = store.newId('mat');
    const outName = newId + '.mp4';

    const meta = await render.renderMaterialTrim(projectId, mat, path.join(matDir, outName));
    const stat = await fs.stat(path.join(matDir, outName));

    const stem = (mat.originalName || mat.filename || '素材').replace(/\.[^.]+$/, '');
    const newMat = {
      id: newId, filename: outName, originalName: `${stem}_剪辑.mp4`,
      mime: 'video/mp4', size: stat.size, status: 'pending',
      type: 'video', duration: +meta.duration.toFixed(2),
      width: meta.width, height: meta.height,
      // 烘焙出的文件必带音轨；整条静音时按无声处理，免得白跑一次字幕识别
      hasAudio: !mat.muted && mat.hasAudio !== false,
      category: '其他', required: false, forbidden: false,
      usable: true, needsConfirm: false, quality: null, problems: [],
      aiTags: [], trimIn: 0, trimOut: +meta.duration.toFixed(2),
      savedFrom: mid, createdAt: new Date().toISOString(),
    };
    await ffmpeg.thumbnail(path.join(matDir, outName), path.join(matDir, 'thumb', newId + '.jpg'), Math.min(1, meta.duration * 0.3), 480).catch(() => {});
    newMat.thumbnail = 'thumb/' + newId + '.jpg';

    const saved = await store.withLock(projectId, async () => {
      const proj = await store.loadProject(projectId);
      proj.materials.push(newMat);
      await store.saveProject(proj);
      return newMat;
    });
    tasks.emitProject(projectId, { type: 'material', material: newMat });
    analyzeAndEmit(projectId, newId);   // 异步分析（AI 分类等），与上传流程一致
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/materials/:mid/reanalyze', async (req, res) => {
  try {
    analyzeAndEmit(req.params.id, req.params.mid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== AI 素材深度审核（画面 / 音频 / 重复 / 分类）=====
// 启动审核：逐段跑真实解码分析，进度走 SSE；不改动任何原始文件
app.post('/api/projects/:id/inspect', async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = await store.loadProject(projectId);
    const pending = (project.materials || []).filter((m) => m.status === 'analyzed' && m.type === 'video');
    if (!pending.length) return res.status(400).json({ error: '没有已分析的视频素材' });
    res.json({ ok: true, count: pending.length });
    runInspection(projectId); // 异步执行
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id/inspect', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const materials = project.materials || [];
    const report = inspect.buildReport(materials);
    res.json({
      report,
      running: !!inspectRunning[req.params.id],
      materials: materials.map((m) => ({
        id: m.id, name: m.name || m.originalName || m.filename, type: m.type,
        duration: m.duration, thumbnail: m.thumbnail,
        category: m.category, excluded: !!m.excluded, mustKeep: !!m.mustKeep, keyShot: !!m.keyShot,
        part: m.part || '',
        trimIn: m.trimIn, trimOut: m.trimOut,
        pieces: m.pieces || null, speed: m.speed || 1,
        marks: Array.isArray(m.marks) ? m.marks : [],
        editDone: !!m.editDone, editDoneAt: m.editDoneAt || null,
        optimized: m.optimized || null, beauty: m.beauty || null,
        inspect: m.inspect || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 生成优化素材：非破坏性裁切（保留原文件）+ 可选防抖 / 曝光校正 / 响度归一
app.post('/api/projects/:id/inspect/apply', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { ids, deshake = true, normalizeAudio = true } = req.body || {};
    res.json({ ok: true });
    applyInspection(projectId, ids, { deshake, normalizeAudio });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const inspectRunning = {};

async function runInspection(projectId) {
  if (inspectRunning[projectId]) return;
  inspectRunning[projectId] = true;
  const emit = (d) => tasks.emitProject(projectId, Object.assign({ type: 'inspect' }, d));
  try {
    const project = await store.loadProject(projectId);
    const list = (project.materials || []).filter((m) => m.status === 'analyzed');
    emit({ status: 'running', progress: 0, message: `开始审核 ${list.length} 个素材` });
    for (let i = 0; i < list.length; i++) {
      const mat = list[i];
      emit({ status: 'running', progress: Math.round(i / list.length * 90), message: `审核 ${i + 1}/${list.length}：${mat.originalName || mat.filename}`, materialId: mat.id });
      const rep = await inspect.inspectMaterial(projectId, mat, (s) => {
        emit({ status: 'running', progress: Math.round(i / list.length * 90), message: `${mat.originalName || mat.filename} · ${s}`, materialId: mat.id });
      });
      await store.withLock(projectId, async () => {
        const p = await store.loadProject(projectId);
        const m = p.materials.find((x) => x.id === mat.id);
        if (!m) return;
        m.inspect = rep;
        // 首次审核自动把有效区间写入裁切点（用户可改）
        if (rep.valid && m.type === 'video') {
          if (m.trimIn === undefined) m.trimIn = rep.valid.in;
          if (m.trimOut === undefined) m.trimOut = rep.valid.out;
        }
        await store.saveProject(p);
      });
    }
    // 全量做一次重复镜头比对（需要所有素材的指纹都就绪）
    emit({ status: 'running', progress: 92, message: '比对重复镜头' });
    await store.withLock(projectId, async () => {
      const p = await store.loadProject(projectId);
      inspect.findDuplicates(p.materials || []);
      for (const m of p.materials || []) {
        if (m.inspect && m.inspect.duplicateOf) m.inspect.bucket = '重复素材';
      }
      const rep = inspect.buildReport(p.materials || []);
      p.inspection = Object.assign({}, rep, { running: false });
      await store.saveProject(p);
    });
    emit({ status: 'done', progress: 100, message: '审核完成' });
  } catch (e) {
    emit({ status: 'error', message: e.message });
  } finally {
    inspectRunning[projectId] = false;
  }
}

// 非破坏性优化：输出到 materials/optimized/，原始文件一律不动
async function applyInspection(projectId, ids, opts) {
  const emit = (d) => tasks.emitProject(projectId, Object.assign({ type: 'inspect-apply' }, d));
  try {
    const project = await store.loadProject(projectId);
    const list = (project.materials || []).filter((m) => (!ids || ids.includes(m.id)) && !m.excluded && m.type === 'video');
    const outDir = path.join(config.materialDir(projectId), 'optimized');
    await fs.mkdir(outDir, { recursive: true });
    for (let i = 0; i < list.length; i++) {
      const mat = list[i];
      emit({ status: 'running', progress: Math.round(i / list.length * 100), message: `优化 ${i + 1}/${list.length}`, materialId: mat.id });
      const src = path.join(config.materialDir(projectId), mat.filename);
      const tin = Number.isFinite(mat.trimIn) ? mat.trimIn : 0;
      const tout = Number.isFinite(mat.trimOut) ? mat.trimOut : (mat.duration || 0);
      const dur = Math.max(0.5, tout - tin);
      const out = path.join(outDir, mat.id + '.mp4');

      const vf = [];
      // 轻微抖动才防抖；vidstab 需要两遍，这里用一次生成的变换文件
      if (opts.deshake && mat.inspect && mat.inspect.shake && mat.inspect.shake.score > 30) {
        const trf = path.join(config.DIRS.temp, `trf_${mat.id}.txt`);
        await ffmpeg.run(config.FFMPEG_PATH, ['-y', '-i', path.resolve(src), '-vf', `vidstabdetect=shakiness=5:accuracy=9:result=${path.resolve(trf)}`, '-f', 'null', '-'], { timeout: 300000 });
        vf.push(`vidstabtransform=smoothing=15:input=${path.resolve(trf)}:zoom=2:optzoom=1`);
      }
      // 曝光校正：按实测亮度做温和的 gamma / 提亮，不重绘内容
      const b = mat.inspect && mat.inspect.bright;
      if (b) {
        if (b.underRatio > 0.25) vf.push('eq=brightness=0.06:saturation=1.05');
        else if (b.overRatio > 0.25) vf.push('eq=brightness=-0.05:saturation=1.02');
      }
      vf.push('fps=30');

      const args = ['-y', '-ss', String(tin), '-t', String(dur), '-i', path.resolve(src)];
      if (mat.hasAudio) args.push('-map', '0:v', '-map', '0:a'); else args.push('-map', '0:v');
      args.push('-vf', vf.join(','));
      if (mat.hasAudio) {
        // 响度归一到 -16 LUFS（短视频常用），并限制真峰值 ≤ -1 dBTP
        const af = opts.normalizeAudio ? 'loudnorm=I=-16:TP=-1.0:LRA=11' : 'anull';
        args.push('-af', af, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(out));
      const { code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, args, { timeout: 600000 });
      if (code !== 0) throw new Error(`优化失败 ${mat.originalName}: ` + String(stderr || '').slice(-200));
      await ffmpeg.thumbnail(out, path.join(outDir, mat.id + '.jpg'), Math.min(1, dur * 0.3), 480).catch(() => {});

      await store.withLock(projectId, async () => {
        const p = await store.loadProject(projectId);
        const m = p.materials.find((x) => x.id === mat.id);
        if (!m) return;
        m.optimized = { file: 'optimized/' + mat.id + '.mp4', thumb: 'optimized/' + mat.id + '.jpg', in: tin, out: tout, duration: +dur.toFixed(2) };
        await store.saveProject(p);
      });
    }
    emit({ status: 'done', progress: 100, message: '优化素材已生成' });
  } catch (e) {
    emit({ status: 'error', message: e.message });
  }
}

// ===== 一键美颜（可选步骤）：人脸磨皮祛痘+瘦脸（mediapipe）+ 产品增艳 + 适度提亮，输出到 materials/beauty/ =====
const beautyRunning = {};
const BEAUTY_PRESETS = {
  // 亮度：原来只有 eq brightness=0.015（≈+4 级），磨皮之后高光被抹平，成片看着发灰偏暗；
  // 改成「brightness + gamma」双管：gamma 抬中间调（人脸/产品不惨白），brightness 抬整体，
  // 实测同一帧 Yavg 123.4（原片）→ 139.5（新适度档），墙面/产品绿更通透，肤色不过曝。
  // 2026-10-29 对齐同行爆款观感：柔和（contrast 略降到 1 以下）+ 自然暖调（colorbalance 红+/蓝-），
  // 磨皮回到轻度（0.6），皮肤白皙均匀但不假面。
  mild:   { label: '适度美颜', smooth: 0.6,  slim: 0.4,
            vf: 'hqdn3d=1:0.8:1.5:1,unsharp=5:5:0.3:5:5:0.0,eq=brightness=0.05:gamma=1.06:contrast=0.99:saturation=1.1,colorbalance=rm=0.04:gm=0.01:bm=-0.04' },
  strong: { label: '明显美颜', smooth: 0.8,  slim: 0.5,
            vf: 'hqdn3d=1.3:1:1.8:1.2,unsharp=5:5:0.32:5:5:0.0,eq=brightness=0.06:gamma=1.07:contrast=1.0:saturation=1.15,colorbalance=rm=0.05:gm=0.01:bm=-0.05' },
};

async function runBeauty(projectId, ids, opts) {
  if (beautyRunning[projectId]) return;
  beautyRunning[projectId] = true;
  const emit = (d) => tasks.emitProject(projectId, Object.assign({ type: 'beauty' }, d));
  try {
    const presetKey = BEAUTY_PRESETS[opts.preset] ? opts.preset : 'mild';
    const preset = BEAUTY_PRESETS[presetKey];
    const project = await store.loadProject(projectId);
    const list = (project.materials || []).filter((m) => (!ids || ids.includes(m.id)) && !m.excluded && !m.beautySkip && m.type === 'video' && m.editDone);
    const outDir = path.join(config.materialDir(projectId), 'beauty');
    await fs.mkdir(outDir, { recursive: true });
    if (!list.length) {
      emit({ status: 'error', message: '没有勾选要美颜的素材（在素材卡上勾选后重试）' });
      return;
    }
    emit({ status: 'running', progress: 0, message: `开始美颜 ${list.length} 个素材（${preset.label}）` });
    let okCount = 0, failCount = 0, doneCount = 0;
    const CONC = 3; // 并行处理 3 个素材，充分利用多核
    // 进度口径：按片段时长分摊权重，正在处理的素材按已渲染帧数折算（python 每 30 帧打一行 PROG），
    // 这样前端「已用 / 预计剩余」才是线性可信的，单条素材也能看到数字在走。
    const rangeOf = (mat) => {
      if (mat.optimized) {
        return {
          src: path.join(config.materialDir(projectId), mat.optimized.file),
          baseIn: Number.isFinite(mat.optimized.in) ? mat.optimized.in : 0,
          tout: mat.optimized.duration || mat.duration || 0,
        };
      }
      return {
        src: path.join(config.materialDir(projectId), mat.filename),
        baseIn: Number.isFinite(mat.trimIn) ? mat.trimIn : 0,
        tout: Number.isFinite(mat.trimOut) ? mat.trimOut : (mat.duration || 0),
      };
    };
    const weightOf = new Map(list.map((m) => { const r = rangeOf(m); return [m.id, Math.max(0.5, r.tout - r.baseIn)]; }));
    const totalW = [...weightOf.values()].reduce((a, b) => a + b, 0) || 1;
    const frac = new Map();   // 正在处理的素材：0~1（完成即从表里删掉，改记进 doneW）
    let doneW = 0, lastEmitAt = 0;
    const pct = () => {
      let acc = doneW;
      for (const [id, f] of frac) acc += (weightOf.get(id) || 1) * Math.min(1, Math.max(0, f));
      return Math.min(99, Math.max(0, Math.round(acc / totalW * 100)));
    };
    const pushProgress = (force) => {
      const now = Date.now();
      if (!force && now - lastEmitAt < 700) return;   // 每帧都推会把 SSE 刷爆，700ms 一次够用
      lastEmitAt = now;
      emit({ status: 'running', progress: pct() });
    };
    // ffmpeg 回退链：从 stderr 的 time=HH:MM:SS.xx 折算这个素材的完成比例
    const ffTimeFrac = (mat, dur) => (chunk) => {
      const all = String(chunk).match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (!all || !all.length) return;
      const p = all[all.length - 1].replace('time=', '').split(':');
      const t = (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]);
      frac.set(mat.id, Math.min(0.97, t / Math.max(0.5, dur)));
      pushProgress();
    };
    const processMat = async (i) => {
      const mat = list[i];
      emit({ status: 'running', progress: pct(), message: `美颜 ${i + 1}/${list.length}：${mat.originalName || mat.filename}`, materialId: mat.id });
      try {
        // 输入优先用已优化副本（已按一次修改截好），否则用原片 + 裁切点；原始文件一律不动
        const { src, baseIn, tout } = rangeOf(mat);
        if (!fsSync.existsSync(src)) throw new Error('源文件不存在');
        const dur = Math.max(0.5, tout - baseIn);
        const totalFrames = Math.max(1, Math.round(dur * 30));   // 输出统一 fps=30，用于把 PROG 帧数折成比例
        const out = path.join(outDir, mat.id + '.mp4');
        // 第一步：人脸感知磨皮祛痘 + 瘦脸 + 调色，一步出成品（python/mediapipe；失败自动退回纯 ffmpeg 链）
        let faceOk = false;
        const tmpFace = path.join(outDir, mat.id + '.face.mp4');
        try {
          const py = asr.resolvePython();
          const r = await ffmpeg.run(py, [
            path.join(config.ROOT, 'scripts', 'beauty_face.py'),
            '--input', path.resolve(src), '--output', path.resolve(tmpFace),
            '--smooth', String(preset.smooth), '--slim', String(preset.slim),
            '--ss', String(baseIn), '--t', String(dur),
            '--vf', preset.vf + ',fps=30',
          ], { timeout: 900000, killOn: /DONE frames=\d+/, onProgress: (chunk) => {
            // python 每 120 帧打一行：PROG frames=N → 折成这条素材的完成比例
            const m = String(chunk).match(/PROG frames=(\d+)/);
            if (!m) return;
            frac.set(mat.id, Math.min(0.97, (+m[1] || 0) / totalFrames));
            pushProgress();
          } });
          if (r.code === 0) { faceOk = true; }
          else console.warn('[beauty] python step failed:', String(r.stderr || '').slice(-300));
        } catch (e) { console.warn('[beauty] python step error:', e.message); }
        let args, code, stderr;
        if (faceOk) {
          frac.set(mat.id, 0.99); pushProgress(true);   // 只差合音轨这一步
          // python 已出成品画面，这里只做封装/合音频（-c:v copy 秒级完成，无二次转码）
          args = ['-y', '-i', path.resolve(tmpFace)];
          if (mat.hasAudio) args.push('-ss', String(baseIn), '-t', String(dur), '-i', path.resolve(src));
          args.push('-map', '0:v');
          if (mat.hasAudio) args.push('-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
          args.push('-c:v', 'copy', '-movflags', '+faststart', path.resolve(out));
          ({ code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, args, { timeout: 600000 }));
        } else {
          // 退回纯 ffmpeg 链（无 python 人脸步骤）：进度改从 time= 折算
          args = ['-y', '-ss', String(baseIn), '-t', String(dur), '-i', path.resolve(src)];
          if (mat.hasAudio) args.push('-map', '0:v', '-map', '0:a'); else args.push('-map', '0:v');
          args.push('-vf', preset.vf + ',fps=30');
          if (mat.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.resolve(out));
          ({ code, stderr } = await ffmpeg.run(config.FFMPEG_PATH, args, { timeout: 600000, onProgress: ffTimeFrac(mat, dur) }));
        }
        if (faceOk) { try { fsSync.unlinkSync(tmpFace); } catch (_) {} }
        if (code !== 0) throw new Error(String(stderr || '').slice(-200));
        await ffmpeg.thumbnail(out, path.join(outDir, mat.id + '.jpg'), Math.min(1, dur * 0.3), 480).catch(() => {});
        await store.withLock(projectId, async () => {
          const p = await store.loadProject(projectId);
          const m = p.materials.find((x) => x.id === mat.id);
          if (!m) return;
          // in 记录美颜副本在原片时间轴上的偏移（供字幕映射），内部时间从 0 开始
          m.beauty = { file: 'beauty/' + mat.id + '.mp4', thumb: 'beauty/' + mat.id + '.jpg', in: baseIn, out: tout, duration: +dur.toFixed(2), preset: presetKey, at: new Date().toISOString() };
          await store.saveProject(p);
        });
        okCount++;
      } catch (e) {
        failCount++;
        frac.delete(mat.id);
        emit({ status: 'running', progress: pct(), message: `${mat.originalName || mat.filename} 美颜失败：${e.message}`, materialId: mat.id, error: e.message });
      }
      doneCount++;
      frac.delete(mat.id);
      doneW += weightOf.get(mat.id) || 1;
      emit({ status: 'running', progress: pct(), message: `已完成 ${doneCount}/${list.length}` });
    };
    const queue = list.map((_, i) => i);
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, async () => {
      while (queue.length) {
        const i = queue.shift();
        await processMat(i);
      }
    }));
    emit({ status: 'done', progress: 100, message: `一键美颜完成：成功 ${okCount} 个${failCount ? '，失败 ' + failCount + ' 个' : ''}` });
  } catch (e) {
    emit({ status: 'error', message: e.message });
  } finally {
    beautyRunning[projectId] = false;
  }
}

app.delete('/api/projects/:id/materials/:mid', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const idx = project.materials.findIndex((m) => m.id === req.params.mid);
    if (idx < 0) return res.status(404).json({ error: '素材不存在' });
    const mat = project.materials[idx];
    try { await fs.unlink(path.join(config.materialDir(req.params.id), mat.filename)); } catch (_) {}
    try { await fs.unlink(path.join(config.materialDir(req.params.id), 'thumb', mat.id + '.jpg')).catch(() => {}); } catch (_) {}
    project.materials.splice(idx, 1);
    await store.saveProject(project);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 素材原文件 / 缩略图
app.get('/api/projects/:id/materials/:mid/file', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.filename);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/api/projects/:id/materials/:mid/thumb', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat || !mat.thumbnail) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.thumbnail);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// 优化后的素材文件 / 缩略图（非破坏性，原文件始终保留）
app.get('/api/projects/:id/materials/:mid/optimized', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat || !mat.optimized) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.optimized.file);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/api/projects/:id/materials/:mid/optimized/thumb', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat || !mat.optimized) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.optimized.thumb);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ===== 一键美颜（可选步骤）=====
app.post('/api/projects/:id/beauty', async (req, res) => {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : null;
    runBeauty(req.params.id, ids, { preset: body.preset });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 撤销美颜：删除美颜副本，恢复用原片/优化副本
app.delete('/api/projects/:id/materials/:mid/beauty', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const mat = project.materials.find((m) => m.id === req.params.mid);
    if (mat && mat.beauty) {
      try { await fs.unlink(path.join(config.materialDir(req.params.id), mat.beauty.file)); } catch (_) {}
      try { await fs.unlink(path.join(config.materialDir(req.params.id), mat.beauty.thumb)); } catch (_) {}
      delete mat.beauty;
      await store.saveProject(project);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/projects/:id/materials/:mid/beauty', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat || !mat.beauty) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.beauty.file);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/api/projects/:id/materials/:mid/beauty/thumb', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const mat = project.materials.find((m) => m.id === req.params.mid);
  if (!mat || !mat.beauty) return res.status(404).end();
  const p = path.join(config.materialDir(req.params.id), mat.beauty.thumb);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ===== 口播字幕识别（本机离线 Whisper，faster-whisper）=====
app.get('/api/asr/status', (req, res) => {
  try { res.json(asr.status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 项目内已识别的字幕概览
app.get('/api/projects/:id/asr', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    // 只有「一次修改」完成过的视频才进字幕识别（未完成的还在上一步）
    const vids = (project.materials || []).filter((m) => m.type === 'video' && !m.excluded);
    const mats = vids.filter((m) => m.editDone);
    // 进到这一步说明用户马上要识别了：按项目配置的模型预热
    try { asr.prewarm({ model: (project.asr && project.asr.model) || undefined }); } catch (_) {}
    res.json({
      engine: asr.status(),
      config: project.asr || { model: '', lang: 'zh', hotwords: '' },
      subtitleSource: (project.subtitle && project.subtitle.source) || 'auto',
      running: !!asrRunning[req.params.id],
      waiting: vids.length - mats.length,
      materials: mats.map((m) => ({
        id: m.id, name: m.name || m.originalName || m.filename, duration: m.duration,
        hasAudio: !!m.hasAudio, category: m.category,
        asr: m.asr || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 启动识别（后台跑，进度走 SSE）
app.post('/api/projects/:id/asr', async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = await store.loadProject(projectId);
    const st = asr.status();
    if (!st.ready) return res.status(400).json({ error: '本机语音识别环境未就绪：' + (st.scriptReady ? '缺少 Whisper 模型' : '缺少识别脚本') });
    const { ids, model, lang, hotwords, force } = req.body || {};
    const cfg = Object.assign({}, project.asr || {}, {
      model: model || (project.asr && project.asr.model) || st.defaultModel || '',
      lang: lang || 'zh',
      hotwords: hotwords !== undefined ? String(hotwords).slice(0, 200) : ((project.asr && project.asr.hotwords) || ''),
    });
    await store.withLock(projectId, async () => {
      const p = await store.loadProject(projectId);
      p.asr = cfg;
      await store.saveProject(p);
    });
    const list = (project.materials || []).filter((m) => m.type === 'video' && m.editDone && (!ids || ids.includes(m.id)));
    const todo = force ? list : list.filter((m) => !m.asr || !m.asr.file);
    if (!todo.length) return res.status(400).json({ error: '没有需要识别的素材（都已识别过，可勾选「重新识别」）' });
    res.json({ ok: true, count: todo.length, model: cfg.model });
    runASRJob(projectId, todo.map((m) => m.id), cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 识别配置（模型 / 热词）单独保存，方便先填热词再点识别
app.post('/api/projects/:id/asr/config', async (req, res) => {
  try {
    const body = req.body || {};
    const updated = await store.withLock(req.params.id, async () => {
      const p = await store.loadProject(req.params.id);
      const cfg = Object.assign({}, p.asr || { lang: 'zh' });
      if (body.model !== undefined) cfg.model = String(body.model);
      if (body.lang !== undefined) cfg.lang = String(body.lang);
      if (body.hotwords !== undefined) cfg.hotwords = String(body.hotwords).slice(0, 200);
      p.asr = cfg;
      await store.saveProject(p);
      return cfg;
    });
    // 换了模型就顺手预热，等用户点识别时已经是常驻进程了
    try { asr.prewarm({ model: updated.model || undefined }); } catch (_) {}
    res.json(updated);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const asrRunning = {};

async function runASRJob(projectId, ids, cfg) {
  if (asrRunning[projectId]) return;
  asrRunning[projectId] = true;
  const emit = (d) => tasks.emitProject(projectId, Object.assign({ type: 'asr' }, d));
  try {
    let project = await store.loadProject(projectId);
    const list = (project.materials || []).filter((m) => ids.includes(m.id));
    // 模型已常驻内存时直接开跑（约 1 秒/条），否则要先等导入+加载，文案上要说清楚
    const warm = asr.warmState();
    emit({
      status: 'running',
      progress: 0,
      message: warm.ready
        ? `开始识别 ${list.length} 个素材的口播字幕（模型已就绪）`
        : `开始识别 ${list.length} 个素材的口播字幕（首次需加载模型，约 20 秒）`,
    });
    // 提示词：把项目名/品牌/热词喂给解码器，减少行业词误识（纯离线，不联网）
    const hot = [project.name, project.brand && project.brand.name, cfg.hotwords]
      .filter(Boolean).join('、').replace(/[，,]+$/, '');
    // 批量识别：所有素材一次进程内跑完，省掉逐条重复的模型加载（原每条 ~35s 开销）
    const entries = await asr.transcribeMaterials(projectId, list, {
      model: cfg.model || undefined,
      lang: cfg.lang || 'zh',
      prompt: hot,
      onFile: (i, n) => {
        const mat = list[i] || {};
        emit({
          status: 'running',
          progress: Math.round(i / n * 100),
          message: `识别 ${i + 1}/${n}：${mat.originalName || mat.filename}`,
          materialId: mat.id,
        });
      },
      onProgress: (p) => emit({
        status: 'running',
        progress: Math.min(99, Math.round(p * 100)),
        message: `识别中 ${Math.round(p * 100)}%`,
      }),
    });
    // 一次性写回所有素材结果
    let done = 0; let failed = 0;
    await store.withLock(projectId, async () => {
      const p = await store.loadProject(projectId);
      for (const e of entries) {
        const m = p.materials.find((x) => x.id === e.mat.id);
        if (!m) continue;
        if (e.error) {
          m.asrError = e.error;
          failed++;
          continue;
        }
        m.asr = e.out.summary;
        // 精简版字幕时间轴存进项目，供混剪按"整句"切镜头（避免切在半句话上）
        m.asrCues = (e.out.cues || []).map((c) => ({ start: c.start, end: c.end, text: c.text }));
        if (e.out.repeats && e.out.repeats.items.length) m.asrRepeats = e.out.repeats.items.slice(0, 8);
        // 自动分类：检测到清晰人声 → 视为口播素材（旧「素材分类」步骤已移除，分类改由 AI 判定）
        if (!e.out.summary.speechless && (e.out.cues || []).length) {
          m.category = '口播讲解';
          m.classifiedBy = 'asr';
        }
        done++;
      }
      await store.saveProject(p);
    });
    emit({ status: 'done', progress: 100, message: `口播字幕识别完成：成功 ${done} 个${failed ? `，失败 ${failed} 个` : ''}` });
  } catch (e) {
    emit({ status: 'error', message: e.message });
  } finally {
    asrRunning[projectId] = false;
  }
}

// 单个素材的识别详情（字幕时间轴 + 重复口播 + 全文）
app.get('/api/projects/:id/materials/:mid/asr', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const mat = (project.materials || []).find((m) => m.id === req.params.mid);
    if (!mat) return res.status(404).json({ error: '素材不存在' });
    const result = await asr.readResult(req.params.id, mat);
    if (!result) return res.json({ ready: false });
    const voiced = asr.hasSpeech(result);
    const cues = voiced ? asr.cuesFromResult(result, {}) : [];
    res.json({
      ready: true,
      meta: mat.asr || null,
      cues,
      speechless: !voiced,
      repeats: asr.findRepeats(result),
      srt: asr.srtFromCues(cues),
      text: result.text || '',
      duration: result.duration,
      language: result.language,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id/materials/:mid/asr/srt', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const mat = (project.materials || []).find((m) => m.id === req.params.mid);
    if (!mat) return res.status(404).end();
    const result = await asr.readResult(req.params.id, mat);
    if (!result) return res.status(404).end();
    const cues = asr.cuesFromResult(result, {});
    const name = (mat.originalName || mat.filename || 'subtitle').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}.srt"`);
    res.send(asr.srtFromCues(cues));
  } catch (e) { res.status(500).end(); }
});

app.delete('/api/projects/:id/materials/:mid/asr', async (req, res) => {
  try {
    await store.withLock(req.params.id, async () => {
      const p = await store.loadProject(req.params.id);
      const m = p.materials.find((x) => x.id === req.params.mid);
      if (!m) return;
      if (m.asr && m.asr.file) {
        try { await fs.unlink(path.join(config.materialDir(req.params.id), m.asr.file)); } catch (_) {}
      }
      delete m.asr; delete m.asrRepeats;
      await store.saveProject(p);
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 成片字幕（SRT）下载：与成片时间轴一致
app.get('/api/projects/:id/videos/:vid/srt', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const v = (project.videos || []).find((x) => x.id === req.params.vid);
    if (!v || !v.srt) return res.status(404).end();
    const p = path.join(config.outputDir(req.params.id), v.srt);
    if (!fsSync.existsSync(p)) return res.status(404).end();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent((v.title || 'video') + '.srt')}"`);
    res.sendFile(p);
  } catch (e) { res.status(500).end(); }
});

// ===== 背景音乐：系统原创配乐（按项目风格自动匹配，可试听/更换）=====
app.get('/api/music/presets', async (req, res) => {
  try {
    res.json({ presets: music.listPresets(), current: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/music/presets/:key/file', async (req, res) => {
  try {
    const t = await music.ensureTrack(req.params.key);
    res.sendFile(t.path);
  } catch (e) { res.status(404).end(); }
});

// ===== 音乐上传 =====
app.post('/api/projects/:id/music', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少文件' });
    const ext = path.extname(req.file.originalname) || '.mp3';
    const name = 'music_' + store.newId('m') + ext;
    const dest = path.join(config.DIRS.music, name);
    await fs.writeFile(dest, req.file.buffer);
    const project = await store.loadProject(req.params.id);
    project.musicPath = dest;
    await store.saveProject(project);
    res.json({ ok: true, musicPath: dest });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/projects/:id/music', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    if (project.musicPath && fsSync.existsSync(project.musicPath)) await fs.unlink(project.musicPath).catch(() => {});
    project.musicPath = '';
    await store.saveProject(project);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 音乐素材库（跨项目留存，上传/生成/删除/试听）=====
const musiclib = require('./lib/musiclib');
app.get('/api/music-library', async (req, res) => {
  try { res.json({ tracks: await musiclib.list() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/music-library', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少文件' });
    const t = await musiclib.addBuffer(req.file.buffer, req.file.originalname, {
      name: req.body.name, style: req.body.style, scene: req.body.scene,
    });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/music-library/generate', async (req, res) => {
  try {
    const key = String((req.body || {}).key || '');
    if (!music.PRESETS[key]) throw new Error('未知的音乐风格');
    res.json(await musiclib.addGenerated(key));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/music-library/:tid', async (req, res) => {
  try { await musiclib.remove(req.params.tid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/music-library/:tid/file', async (req, res) => {
  try {
    const t = await musiclib.get(req.params.tid);
    if (!t || !fsSync.existsSync(t.file)) return res.status(404).end();
    res.sendFile(t.file);
  } catch (e) { res.status(404).end(); }
});

// ===== 渲染任务 =====
app.post('/api/projects/:id/render', async (req, res) => {
  try {
    // 步骤门槛：没在「一次修改」里完成的素材不参与成片
    const project = await store.loadProject(req.params.id);
    const ready = (project.materials || []).some((m) => m.editDone && !m.forbidden && !m.excluded);
    if (!ready) {
      return res.status(400).json({ error: '还没有「一次修改」完成的素材。先去「② 一次修改」点「完成修改」，再回来生成。' });
    }
    const task = await tasks.enqueue(req.params.id, req.body || {});
    res.json({ ok: true, taskId: task.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SSE 进度
app.get('/api/projects/:id/stream', (req, res) => {
  tasks.subscribe('project:' + req.params.id, req, res);
});
app.get('/api/tasks/:taskId/stream', (req, res) => {
  tasks.subscribe('task:' + req.params.taskId, req, res);
});

// ===== 视频操作 =====
app.patch('/api/projects/:id/videos/:vid', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const v = project.videos.find((x) => x.id === req.params.vid);
    if (!v) return res.status(404).json({ error: '视频不存在' });
    for (const k of ['title', 'locked', 'rename']) {
      if (req.body[k] !== undefined) {
        if (k === 'rename') v.title = req.body[k];
        else v[k] = req.body[k];
      }
    }
    // 字幕逐段调整：整体替换 segments（前端已携带每段 subtitleStyle，且不改动其它字段）
    if (Array.isArray(req.body.segments)) {
      v.segments = req.body.segments;
    }
    await store.saveProject(project);
    res.json(v);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 成片二次剪辑：按保留区间重渲成片（原片备份 .bak，字幕已烧进画面跟着保留）
app.post('/api/projects/:id/videos/:vid/cut', async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = await store.loadProject(projectId);
    const v = project.videos.find((x) => x.id === req.params.vid);
    if (!v) return res.status(404).json({ error: '视频不存在' });
    const srcPath = path.join(config.outputDir(projectId), v.path);
    if (!fsSync.existsSync(srcPath)) return res.status(404).json({ error: '成片文件缺失，请重新生成' });
    const pieces = (req.body && Array.isArray(req.body.pieces)) ? req.body.pieces : null;
    if (!pieces || !pieces.length) return res.status(400).json({ error: '没有保留区间' });
    const outDir = config.outputDir(projectId);
    const tmpOut = path.join(outDir, 'cuttmp_' + Date.now() + '.mp4');
    await render.cutVideoFile(srcPath, pieces, tmpOut);
    // 原片备份 → 剪辑结果顶替（与素材「保存替换」同一套习惯）
    const bakName = String(v.path).replace(/\.mp4$/i, '') + '_orig_' + Date.now() + '.bak.mp4';
    try { await fs.rename(srcPath, path.join(outDir, bakName)); } catch (_) {}
    await fs.rename(tmpOut, srcPath);
    // 更新记录：时长/体积按新文件，缩略图重取
    try {
      const meta = await ffmpeg.probe(srcPath);
      v.duration = meta.duration || v.duration;
      v.size = meta.size || v.size;
    } catch (_) {}
    v.cut = { pieces, at: new Date().toISOString() };
    try {
      const thumbDir = path.join(outDir, 'thumb');
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = path.basename(srcPath, '.mp4') + '.jpg';
      await ffmpeg.thumbnail(srcPath, path.join(thumbDir, thumbName), Math.min(1, (v.duration || 3) * 0.3), 480);
      v.thumbnail = 'thumb/' + thumbName;
    } catch (_) {}
    await store.saveProject(project);
    tasks.emitProject(projectId, { type: 'video-cut', videoId: v.id });
    res.json(v);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id/videos/:vid', async (req, res) => {
  try { await tasks.deleteVideo(req.params.id, req.params.vid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/projects/:id/videos/:vid/file', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const v = project.videos.find((x) => x.id === req.params.vid);
  if (!v) return res.status(404).end();
  const p = path.join(config.outputDir(req.params.id), v.path);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/api/projects/:id/videos/:vid/thumb', async (req, res) => {
  const project = await store.loadProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).end();
  const v = project.videos.find((x) => x.id === req.params.vid);
  if (!v || !v.thumbnail) return res.status(404).end();
  const p = path.join(config.outputDir(req.params.id), v.thumbnail);
  if (!fsSync.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// ===== 全站聚合：今日新生成视频 / 进行中任务 =====
app.get('/api/today/videos', async (req, res) => {
  try {
    const data = await store.todayVideos(videoScope(req));
    const names = await auth.getUserMap();
    data.items = data.items.map((v) => Object.assign(v, { ownerName: names[v.ownerId] || '未归属' }));
    data.count = data.items.length;
    res.json(Object.assign(data, scopeInfo(req)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/today/tasks', async (req, res) => {
  try {
    const data = await store.runningTasks(scopedUser(req));
    const names = await auth.getUserMap();
    data.items = data.items.map((v) => Object.assign(v, { ownerName: names[v.ownerId] || '未归属' }));
    data.count = data.items.length;
    const info = scopeInfo(req);
    // 任务列表：主账号看全部（或指定成员），子账号只看自己（「全部视频」授权不影响任务范围）
    const taskScope = req.user.role === 'owner' ? info.scope : 'mine';
    res.json(Object.assign(data, { scope: taskScope, canViewAllVideos: info.canViewAllVideos }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 今日视频一键打包下载
app.get('/api/today/videos/zip', async (req, res) => {
  try {
    const data = await store.todayVideos(videoScope(req));
    const list = data.items.filter((v) => v.size > 0);
    if (!list.length) return res.status(404).json({ error: '今天还没有生成视频' });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="today_videos_${data.date}.zip"`,
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    let i = 0;
    for (const v of list) {
      const real = path.join(config.outputDir(v.projectId), v.path || '');
      if (v.path && fsSync.existsSync(real)) {
        i += 1;
        const safe = `${String(i).padStart(2, '0')}_${(v.projectName || 'project').replace(/[\\/:*?"<>|]/g, '_')}_${v.version}.mp4`;
        archive.file(real, { name: safe });
      }
    }
    await archive.finalize();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ZIP 批量下载
app.get('/api/projects/:id/videos/zip', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    const videos = project.videos || [];
    if (!videos.length) return res.status(404).json({ error: '没有可下载的视频' });
    const safeZip = `videos_${Date.now()}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${safeZip}"`,
    });
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    for (const v of videos) {
      const p = path.join(config.outputDir(req.params.id), v.path);
      if (fsSync.existsSync(p)) {
        const name = `${(v.title || v.version).replace(/[\\/:*?"<>|]/g, '_')}_${v.version}.mp4`;
        archive.file(p, { name });
      }
    }
    await archive.finalize();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 在线状态 =====
// 全部登录账号的在线状态，成员之间互相可见
app.get('/api/presence', async (req, res) => {
  try {
    const users = await auth.listUsers();
    const map = {};
    for (const u of users) map[u.id] = presence.viewOf(u, u.lastSeenAt);
    res.json({ me: req.user.id, at: new Date().toISOString(), users: map });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 心跳：页面每 25 秒调一次，保持在线
app.post('/api/presence/ping', async (req, res) => {
  try {
    res.json({ ok: true, at: new Date().toISOString(), me: presence.touch(req.user.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动切换在线模式：online / busy / away
app.post('/api/presence/status', async (req, res) => {
  try {
    const me = presence.setStatus(req.user.id, (req.body || {}).status);
    res.json({ ok: true, me });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ===== 站内聊天（私聊 + 传文件）=====
// 把消息实时推给收发双方（多标签页同步），并刷新收件人未读数
async function pushChatMessage(msg) {
  const payload = { type: 'chat', message: msg, at: msg.at };
  presence.push(msg.to, payload);
  presence.push(msg.from, payload);
  try {
    const n = await chat.unreadTotal(msg.to);
    presence.push(msg.to, { type: 'unread', total: n, peer: msg.from });
  } catch (_) {}
}

function chatUserView(u) {
  return {
    id: u.id, username: u.username, displayName: u.displayName || u.username,
    account: u.account, role: u.role,
    level: u.level, levelName: u.levelName, levelRank: u.levelRank, levelDesc: u.levelDesc,
    manageLevel: u.manageLevel, manageName: u.manageName, manageRank: u.manageRank, manageDesc: u.manageDesc,
    levelText: u.levelText,
    avatarUrl: u.avatarUrl, phone: u.phone, bio: u.bio,
    disabled: u.disabled, isManager: u.isManager,
    lastLoginAt: u.lastLoginAt || null, lastSeenAt: u.lastSeenAt || null,
  };
}

// 同事列表：在线状态 + 未读数 + 最后一条消息
app.get('/api/chat/users', async (req, res) => {
  try {
    const users = await auth.listUsers();
    const me = req.user.id;
    const unread = await chat.unreadByPeer(me);
    const inbox = await chat.inbox(me);
    const byPeer = {};
    inbox.forEach((r) => { byPeer[r.peerId] = r; });
    const list = users.filter((u) => u.id !== me).map((u) => {
      const row = byPeer[u.id] || null;
      return {
        user: chatUserView(u),
        presence: presence.viewOf(u, u.lastSeenAt),
        unread: unread[u.id] || 0,
        last: row ? row.last : null,
        messageCount: row ? row.total : 0,
      };
    });
    // 排序：在线优先，其次有消息的按时间倒序，最后按职级
    list.sort((a, b) => {
      const ao = a.presence.online ? 1 : 0, bo = b.presence.online ? 1 : 0;
      if (ao !== bo) return bo - ao;
      const at = a.last ? a.last.at : '', bt = b.last ? b.last.at : '';
      if (at !== bt) return String(bt).localeCompare(String(at));
      // 同级按「管理岗优先、再看专业职级」
      if ((b.user.manageRank || 0) !== (a.user.manageRank || 0)) return (b.user.manageRank || 0) - (a.user.manageRank || 0);
      return (b.user.levelRank || 0) - (a.user.levelRank || 0);
    });
    res.json({
      me: me,
      users: list,
      totalUnread: Object.values(unread).reduce((a, b) => a + b, 0),
      at: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 拉取与某人的聊天记录
app.get('/api/chat/messages', async (req, res) => {
  try {
    const peer = String(req.query.with || '');
    if (!peer) return res.status(400).json({ error: '缺少聊天对象' });
    const target = await auth.getUserById(peer);
    if (!target) return res.status(404).json({ error: '账号不存在' });
    const data = await chat.messagesWith(req.user.id, peer, { before: req.query.before, limit: req.query.limit });
    res.json(Object.assign({ peer: chatUserView(target), presence: presence.viewOf(target, target.lastSeenAt) }, data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 发文字消息
app.post('/api/chat/messages', async (req, res) => {
  try {
    const { to, text } = req.body || {};
    if (!to) return res.status(400).json({ error: '缺少收件人' });
    const target = await auth.getUserById(String(to));
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.disabled) return res.status(400).json({ error: '对方账号已停用' });
    const msg = await chat.send({ from: req.user.id, to: target.id, text });
    await pushChatMessage(msg);
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 发附件（图片 / 文档 / 视频都可以，单文件 ≤100MB）
app.post('/api/chat/upload', chatMw, async (req, res) => {
  let tmp = null;
  try {
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });
    tmp = req.file.path;
    const { to, text } = req.body || {};
    if (!to) return res.status(400).json({ error: '缺少收件人' });
    const target = await auth.getUserById(String(to));
    if (!target) return res.status(404).json({ error: '账号不存在' });
    if (target.disabled) return res.status(400).json({ error: '对方账号已停用' });
    const meta = await chat.adoptFile(tmp, req.file.originalname);
    tmp = null;
    const msg = await chat.send({
      from: req.user.id, to: target.id, text,
      file: { id: meta.id, name: meta.name, size: meta.size, mime: req.file.mimetype || '', storedName: meta.storedName },
    });
    await pushChatMessage(msg);
    res.json({ ok: true, message: msg });
  } catch (e) {
    if (tmp) fs.unlink(tmp).catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

// 标记与某人的会话已读
app.post('/api/chat/read', async (req, res) => {
  try {
    const peer = String((req.body || {}).peer || '');
    if (!peer) return res.status(400).json({ error: '缺少聊天对象' });
    const n = await chat.markRead(req.user.id, peer);
    const total = await chat.unreadTotal(req.user.id);
    presence.push(peer, { type: 'read', peer: req.user.id, count: n, at: new Date().toISOString() });
    res.json({ ok: true, read: n, totalUnread: total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 下载 / 预览附件（发送方、接收方与主账号可访问）
app.get('/api/chat/files/:fid', async (req, res) => {
  try {
    const msg = await chat.findFileMessage(String(req.params.fid || ''));
    if (!msg) return res.status(404).json({ error: '文件不存在' });
    if (!chat.canSeeMessage(req.user, msg)) return res.status(403).json({ error: '无权访问该文件' });
    const file = chat.filePathOf(msg.file.storedName);
    if (!fsSync.existsSync(file)) return res.status(404).json({ error: '文件已丢失' });
    const inline = req.query.inline === '1' && /^image\//i.test(msg.file.mime || '');
    const name = msg.file.name || 'file';
    res.setHeader('Content-Type', msg.file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.resolve(file));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 实时事件流：在线状态变化 / 新消息 / 已读回执
app.get('/api/chat/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  presence.attach(req.user.id, res);
  try {
    const users = await auth.listUsers();
    const map = {};
    for (const u of users) map[u.id] = presence.viewOf(u, u.lastSeenAt);
    const unread = await chat.unreadTotal(req.user.id);
    presence.send(res, { type: 'ready', me: req.user.id, users: map, totalUnread: unread, at: new Date().toISOString() });
  } catch (_) {}
  const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
  if (timer.unref) timer.unref();
  req.on('close', () => { clearInterval(timer); });
});

// 主账号：全部会话总览（谁和谁聊了多少条）
app.get('/api/chat/audit', auth.ownerOnly, async (req, res) => {
  try {
    const users = await auth.listUsers();
    const map = {};
    users.forEach((u) => { map[u.id] = chatUserView(u); });
    const convs = await chat.allConversations();
    const rows = convs.map((c) => ({
      key: c.key,
      a: map[c.a] || { id: c.a, displayName: '已删除账号' },
      b: map[c.b] || { id: c.b, displayName: '已删除账号' },
      count: c.count,
      files: c.files,
      firstAt: c.firstAt,
      lastAt: c.lastAt,
      preview: c.last ? (c.last.file && !c.last.text ? '[文件] ' + c.last.file.name : c.last.text) : '',
      lastFrom: c.last ? c.last.from : null,
    }));
    const unread = {};
    for (const u of users) unread[u.id] = await chat.unreadTotal(u.id);
    res.json({ rows, stats: await chat.stats(), users: map, unread, at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 主账号：查看任意两人的聊天记录
app.get('/api/chat/audit/messages', auth.ownerOnly, async (req, res) => {
  try {
    const a = String(req.query.a || ''), b = String(req.query.b || '');
    if (!a || !b) return res.status(400).json({ error: '缺少会话成员' });
    const [ua, ub] = await Promise.all([auth.getUserById(a), auth.getUserById(b)]);
    if (!ua || !ub) return res.status(404).json({ error: '账号不存在' });
    const data = await chat.messagesWith(a, b, { before: req.query.before, limit: req.query.limit || 200 });
    res.json(Object.assign({
      a: chatUserView(ua), b: chatUserView(ub),
      presence: { [a]: presence.viewOf(ua, ua.lastSeenAt), [b]: presence.viewOf(ub, ub.lastSeenAt) },
    }, data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 主账号：把某段会话导出成纯文本（留痕 / 交接）
app.get('/api/chat/audit/export', auth.ownerOnly, async (req, res) => {
  try {
    const a = String(req.query.a || ''), b = String(req.query.b || '');
    const [ua, ub] = await Promise.all([auth.getUserById(a), auth.getUserById(b)]);
    if (!ua || !ub) return res.status(404).json({ error: '账号不存在' });
    const data = await chat.messagesWith(a, b, { limit: 500 });
    const fmt = (iso) => new Date(iso).toLocaleString('zh-CN', { hour12: false });
    const lines = [
      '电商·视频混剪工作台 · 站内聊天记录',
      `会话：${ua.displayName || ua.username}（${ua.levelText}） ↔ ${ub.displayName || ub.username}（${ub.levelText}）`,
      `导出时间：${fmt(new Date().toISOString())}　共 ${data.messages.length} 条`,
      ''.padEnd(48, '-'),
      '',
    ];
    for (const m of data.messages) {
      const who = m.from === a ? (ua.displayName || ua.username) : (ub.displayName || ub.username);
      let body = m.text ? m.text.replace(/\n/g, ' ') : '';
      if (m.file) body += `${body ? ' ' : ''}[文件] ${m.file.name}（${m.file.size} 字节）`;
      lines.push(`[${fmt(m.at)}] ${who}：${body}${m.readAt ? '' : '（未读）'}`);
    }
    const name = `聊天记录_${ua.displayName || ua.username}_${ub.displayName || ub.username}.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="chat.txt"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(lines.join('\r\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 设置 =====
const SETTINGS_FILE = path.join(config.DIRS.data, 'settings.json');
// 成片模板目录（新建项目页的「剪辑风格」下拉用它渲染）
app.get('/api/project-templates', (req, res) => {
  res.json({ templates: templates.list(), default: '口播介绍' });
});

app.get('/api/settings', async (req, res) => {
  try {
    const s = fsSync.existsSync(SETTINGS_FILE) ? JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) : {};
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings', auth.ownerOnly, async (req, res) => {
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(req.body || {}, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== 启动 =====
chat.init().catch((e) => console.error('[chat] 初始化失败:', e.message));
presence.startSweeper();
sweepTempUploads();

// 清理"上传中途放弃"留下的分片目录（正常完成后会自动删，异常退出才会残留）
// 只动 data/temp 下 upload_ 开头、且超过 12 小时没更新的目录，绝不碰素材/成片
async function sweepTempUploads() {
  const MAX_AGE = 6 * 3600 * 1000;
  try {
    const dir = config.DIRS.temp;
    const entries = await fs.readdir(dir).catch(() => []);
    const now = Date.now();
    let freed = 0, n = 0;
    for (const name of entries) {
      if (!/^upload_/.test(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fs.stat(p);
        if (!st.isDirectory() || now - st.mtimeMs < MAX_AGE) continue;
        const inner = await fs.readdir(p).catch(() => []);
        for (const f of inner) {
          const fp = path.join(p, f);
          const fs2 = await fs.stat(fp).catch(() => null);
          await fs.unlink(fp).catch(() => {});
          if (fs2) freed += fs2.size;
        }
        await fs.rmdir(p).catch(() => {});
        n++;
      } catch (_) { /* 单个目录失败不影响其他 */ }
    }
    if (n) console.log(`[temp] 已清理 ${n} 个过期上传临时目录，释放 ${Math.round(freed / 1048576)}MB`);
  } catch (_) { /* 清理失败不影响启动 */ }
  // 每 6 小时再扫一次，避免长期运行的服务越积越多
  setTimeout(sweepTempUploads, 6 * 3600 * 1000).unref();
}
app.listen(config.PORT, () => {
  console.log(`电商·视频混剪工作台已启动: http://localhost:${config.PORT}`);
  console.log(`FFmpeg: ${config.FFMPEG_PATH}`);
  console.log(`FFprobe: ${config.FFPROBE_PATH}`);
  // 开机就把语音识别模型拉进内存：冷启动的 20 多秒几乎全花在 python 导入 + 权重加载上，
  // 挪到启动阶段做，运营点「字幕识别」时就是秒出。
  setTimeout(() => {
    try {
      asr.prewarm({});
      console.log('[asr] 正在预热语音识别模型（后台，不影响其他功能）');
    } catch (e) { console.warn('[asr] prewarm 跳过:', e.message); }
  }, 1500);
});
