// test/permissions.js - 「管理权限」与「可看全部视频」授权端到端测试
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function client() {
  let cookie = '';
  async function req(method, path, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setC) {
      const kv = c.split(';')[0];
      if (kv.startsWith('sid=')) cookie = kv;
    }
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json, raw: r };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b || {}),
    patch: (p, b) => req('PATCH', p, b || {}),
    del: (p) => req('DELETE', p),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

(async () => {
  const owner = client();
  const a = client();
  const b = client();
  const suffix = Date.now().toString().slice(-6);
  const accA = 'perma' + suffix;
  const accB = 'permb' + suffix;
  let opA = null, opB = null;

  // ---------- 0. 主账号登录 ----------
  const lo = await owner.post('/api/auth/login', { account: '15954896689', password: '789215' });
  check('主账号登录成功', lo.status === 200 && lo.json.user.role === 'owner', JSON.stringify(lo.json));
  const ownerMe = lo.json.user;
  check('主账号权限为全部（canViewAllVideos=true）', ownerMe.permissions && ownerMe.permissions.viewAllVideos === true, JSON.stringify(ownerMe.permissions));

  // ---------- 1. 建两个子账号 ----------
  const cA = await owner.post('/api/team/users', { username: '权限测A' + suffix, account: accA, password: 'op123456' });
  const cB = await owner.post('/api/team/users', { username: '权限测B' + suffix, account: accB, password: 'op123456' });
  check('创建子账号 A 成功', cA.status === 200 && cA.json.id, JSON.stringify(cA.json));
  check('创建子账号 B 成功', cB.status === 200 && cB.json.id, JSON.stringify(cB.json));
  opA = cA.json; opB = cB.json;
  check('新子账号默认 viewAllVideos=false', cA.json.permissions && cA.json.permissions.viewAllVideos === false, JSON.stringify(cA.json.permissions));
  check('新子账号默认 canViewAllVideos=false', cA.json.canViewAllVideos === false, String(cA.json.canViewAllVideos));

  const la = await a.post('/api/auth/login', { account: accA, password: 'op123456' });
  const lb = await b.post('/api/auth/login', { account: accB, password: 'op123456' });
  check('子账号 A 登录成功', la.status === 200, JSON.stringify(la.json));
  check('子账号 B 登录成功', lb.status === 200, JSON.stringify(lb.json));

  // ---------- 2. 子账号默认只能看自己 ----------
  const aVideosBefore = await a.get('/api/today/videos');
  check('A 默认「今日视频」范围为 mine', aVideosBefore.json.scope === 'mine', JSON.stringify(aVideosBefore.json.scope));
  check('A 默认看不到任何他人视频', aVideosBefore.json.items.every((v) => v.ownerId === opA.id), 'items=' + aVideosBefore.json.items.length);

  const ownerVideos = (await owner.get('/api/today/videos')).json;
  check('主账号可见全部今日视频（含他人）', ownerVideos.scope === 'all' && ownerVideos.count >= 1, JSON.stringify({ scope: ownerVideos.scope, count: ownerVideos.count }));
  const sample = ownerVideos.items.find((v) => v.size > 0 && v.ownerId !== opA.id);
  check('存在可用于验证的他人视频样本', !!sample, 'count=' + ownerVideos.count);

  const aStatsBefore = (await a.get('/api/stats')).json;
  check('A 默认统计只看自己', aStatsBefore.todayVideos === 0 && aStatsBefore.projectCount === 0, JSON.stringify(aStatsBefore));

  // ---------- 3. 权限接口只有主账号可访问 ----------
  const aPermApi = await a.get('/api/team/permissions');
  check('子账号访问 /api/team/permissions 返回 403', aPermApi.status === 403, 'code=' + aPermApi.status);
  const aOverview = await a.get('/api/team/overview');
  check('子账号访问 /api/team/overview 返回 403', aOverview.status === 403, 'code=' + aOverview.status);
  const aPatch = await a.patch('/api/team/users/' + opB.id, { permissions: { viewAllVideos: true } });
  check('子账号不能给自己/他人改权限', aPatch.status === 403, 'code=' + aPatch.status);
  const aPermPage = await fetch(BASE + '/permissions.html');
  check('权限页静态资源可访问（前端按 ownerOnly 跳转）', aPermPage.status === 200);

  // ---------- 4. 主账号读取权限总览 ----------
  const permList = await owner.get('/api/team/permissions');
  check('主账号可读取权限总览', permList.status === 200 && Array.isArray(permList.json.rows), 'code=' + permList.status);
  const rowA = (permList.json.rows || []).find((r) => r.id === opA.id);
  check('权限总览含新建子账号且默认关闭', rowA && rowA.canViewAllVideos === false, JSON.stringify(rowA && rowA.canViewAllVideos));

  // ---------- 5. 主账号单独给 A 授权「可看全部视频」 ----------
  const grant = await owner.patch('/api/team/users/' + opA.id, { permissions: { viewAllVideos: true } });
  check('主账号授权 A 查看全部视频', grant.status === 200 && grant.json.canViewAllVideos === true, JSON.stringify(grant.json && grant.json.permissions));

  const aMe = await a.get('/api/auth/me');
  check('授权后 A 当前会话立刻生效', aMe.json.user.canViewAllVideos === true, JSON.stringify(aMe.json.user && aMe.json.user.permissions));

  const aVideosAfter = await a.get('/api/today/videos');
  check('A 授权后范围为 all', aVideosAfter.json.scope === 'all', JSON.stringify(aVideosAfter.json.scope));
  check('A 授权后能看到全部成员的今日视频', aVideosAfter.json.count === ownerVideos.count, `${aVideosAfter.json.count} vs ${ownerVideos.count}`);
  check('A 授权后能看到他人视频', aVideosAfter.json.items.some((v) => v.ownerId !== opA.id), 'items=' + aVideosAfter.json.count);
  check('授权列表带归属人名称', aVideosAfter.json.items.every((v) => !!v.ownerName), 'ok');

  const aStatsAfter = (await a.get('/api/stats')).json;
  check('A 授权后首页统计仍只算自己', aStatsAfter.todayVideos === 0 && aStatsAfter.projectCount === 0, JSON.stringify(aStatsAfter));
  const aProjectsAfter = (await a.get('/api/projects')).json;
  check('A 授权后项目列表仍只有自己（0 个）', Array.isArray(aProjectsAfter) && aProjectsAfter.length === 0, 'len=' + aProjectsAfter.length);

  const aTasks = await a.get('/api/today/tasks');
  check('A 授权后「进行中任务」仍只含自己', aTasks.json.items.every((t) => t.ownerId === opA.id), 'items=' + aTasks.json.items.length);
  check('A 授权后任务范围标记为 mine', aTasks.json.scope === 'mine', JSON.stringify(aTasks.json.scope));

  // ---------- 6. 授权的边界：可播可下，不可进项目 ----------
  if (sample) {
    const vf = await a.get(sample.fileUrl);
    check('A 可播放/下载他人视频文件', vf.status === 200, 'code=' + vf.status);
    if (vf.raw.body) { try { await vf.raw.body.cancel(); } catch (_) {} }
    const th = await a.get(sample.thumbUrl || sample.fileUrl);
    check('A 可读取他人视频缩略图', th.status === 200, 'code=' + th.status);
    if (th.raw.body) { try { await th.raw.body.cancel(); } catch (_) {} }

    const proj = await a.get('/api/projects/' + sample.projectId);
    check('A 不能进入他人项目详情（403）', proj.status === 403, 'code=' + proj.status);
    const patchOther = await a.patch('/api/projects/' + sample.projectId + '/videos/' + sample.id, { locked: true });
    check('A 不能修改他人视频（403）', patchOther.status === 403, 'code=' + patchOther.status);
    const delOther = await a.del('/api/projects/' + sample.projectId + '/videos/' + sample.id);
    check('A 不能删除他人视频（403）', delOther.status === 403, 'code=' + delOther.status);
    const zip = await a.get('/api/today/videos/zip');
    check('A 可打包下载今日全部视频', zip.status === 200, 'code=' + zip.status);
    if (zip.raw.body) { try { await zip.raw.body.cancel(); } catch (_) {} }
  }

  // ---------- 7. 未授权的 B 依然被隔离 ----------
  const bVideos = await b.get('/api/today/videos');
  check('B 未授权仍只看自己', bVideos.json.scope === 'mine' && bVideos.json.items.every((v) => v.ownerId === opB.id), JSON.stringify(bVideos.json.scope));
  if (sample) {
    const bf = await b.get(sample.fileUrl);
    check('B 未授权不能读他人视频文件（403）', bf.status === 403, 'code=' + bf.status);
    if (bf.raw.body) { try { await bf.raw.body.cancel(); } catch (_) {} }
  }

  // ---------- 8. 主账号设置子账号权限的其它校验 ----------
  const ownerPerm = await owner.patch('/api/team/users/usr_owner', { permissions: { viewAllVideos: false } });
  check('主账号权限不可被修改（400）', ownerPerm.status === 400, 'code=' + ownerPerm.status);
  const topLevel = await owner.patch('/api/team/users/' + opB.id, { viewAllVideos: true });
  check('也支持 viewAllVideos 顶层字段授权', topLevel.status === 200 && topLevel.json.canViewAllVideos === true, JSON.stringify(topLevel.json && topLevel.json.canViewAllVideos));

  // ---------- 9. 收回权限 ----------
  const revoke = await owner.patch('/api/team/users/' + opA.id, { permissions: { viewAllVideos: false } });
  check('主账号收回 A 的全部视频权限', revoke.status === 200 && revoke.json.canViewAllVideos === false, JSON.stringify(revoke.json && revoke.json.canViewAllVideos));
  const aAfterRevoke = await a.get('/api/today/videos');
  check('收回后 A 立刻只能看自己', aAfterRevoke.json.scope === 'mine' && aAfterRevoke.json.items.every((v) => v.ownerId === opA.id), JSON.stringify(aAfterRevoke.json.scope));
  if (sample) {
    const af = await a.get(sample.fileUrl);
    check('收回后 A 不能读他人视频（403）', af.status === 403, 'code=' + af.status);
    if (af.raw.body) { try { await af.raw.body.cancel(); } catch (_) {} }
  }

  // ---------- 10. 权限持久化（重新登录仍有效） ----------
  await owner.patch('/api/team/users/' + opB.id, { permissions: { viewAllVideos: true } });
  const b2 = client();
  const lb2 = await b2.post('/api/auth/login', { account: accB, password: 'op123456' });
  check('B 重新登录后权限仍在', lb2.status === 200 && lb2.json.user.canViewAllVideos === true, JSON.stringify(lb2.json.user && lb2.json.user.permissions));

  // ---------- 11. 停用账号后权限接口/数据都不可用 ----------
  await owner.patch('/api/team/users/' + opB.id, { disabled: true });
  const bDisabled = await b2.get('/api/today/videos');
  check('停用后 B 旧会话失效', bDisabled.status === 401, 'code=' + bDisabled.status);

  // ---------- 12. 团队管理仍能看到权限标记 ----------
  const ov = await owner.get('/api/team/overview');
  const ovA = (ov.json.rows || []).find((r) => r.user.id === opA.id);
  check('团队管理接口返回权限字段', ovA && ovA.user.permissions && ovA.user.permissions.viewAllVideos === false, JSON.stringify(ovA && ovA.user.permissions));

  // ---------- 清理 ----------
  await owner.del('/api/team/users/' + opA.id);
  await owner.del('/api/team/users/' + opB.id);
  const finalList = await owner.get('/api/team/permissions');
  const leftovers = (finalList.json.rows || []).filter((r) => r.id === opA.id || r.id === opB.id);
  check('测试账号已清理', leftovers.length === 0, JSON.stringify(leftovers.map((r) => r.id)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
