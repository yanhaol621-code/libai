// test/auth.js - 账号体系与权限隔离端到端测试
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

// 简单的 cookie 会话客户端
function client() {
  let cookie = '';
  async function req(method, path, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const owner = client();
  const op = client();

  // ---------- 0. 未登录访问 ----------
  const anon = client();
  const a1 = await anon.get('/api/projects');
  check('未登录访问 /api/projects 返回 401', a1.status === 401, 'code=' + a1.status);
  const a2 = await anon.post('/api/projects', { name: 'x' });
  check('未登录创建项目被拒绝', a2.status === 401, 'code=' + a2.status);

  // ---------- 1. 主账号登录 ----------
  const l1 = await owner.post('/api/auth/login', { account: '15954896689', password: '789215' });
  check('主账号 15954896689 登录成功', l1.status === 200 && l1.json.user.role === 'owner', JSON.stringify(l1.json));
  check('主账号用户名为「李白」', l1.json.user && l1.json.user.username === '李白', l1.json.user && l1.json.user.username);
  const me1 = await owner.get('/api/auth/me');
  check('主账号 /api/auth/me 正常', me1.status === 200 && me1.json.user.account === '15954896689');

  // ---------- 2. 主账号建子账号 ----------
  const suffix = Date.now().toString().slice(-6);
  const acc = 'yunying' + suffix;
  const c1 = await owner.post('/api/team/users', { username: '测试运营' + suffix, account: acc, password: 'op123456' });
  check('主账号创建子账号成功', c1.status === 200 && c1.json.role === 'operator', JSON.stringify(c1.json));
  const opId = c1.json.id;

  const dup = await owner.post('/api/team/users', { username: '测试运营' + suffix + 'b', account: acc, password: 'op123456' });
  check('重复登录账号被拒绝', dup.status === 400, JSON.stringify(dup.json));
  const shortPwd = await owner.post('/api/team/users', { username: 'x' + suffix, account: 'abc' + suffix, password: '123' });
  check('密码过短被拒绝', shortPwd.status === 400);

  // ---------- 3. 子账号登录 ----------
  const l2 = await op.post('/api/auth/login', { account: acc, password: 'op123456' });
  check('子账号登录成功', l2.status === 200 && l2.json.user.role === 'operator', JSON.stringify(l2.json));

  // ---------- 4. 数据隔离 ----------
  const ownerProjects = (await owner.get('/api/projects')).json;
  const opProjects = (await op.get('/api/projects')).json;
  check('新子账号看不到主账号项目', Array.isArray(opProjects) && opProjects.length === 0, 'got=' + JSON.stringify(opProjects));
  check('主账号能看到自己的项目', ownerProjects.length >= 1);

  const opStats = (await op.get('/api/stats')).json;
  check('子账号统计为 0 项目', opStats.projectCount === 0, JSON.stringify(opStats));

  // 子账号建自己的项目
  const np = await op.post('/api/projects', { name: '运营测试项目' + suffix, category: '包装盒', ratio: '9:16', duration: 15, count: 1, style: '产品实拍展示' });
  check('子账号可创建项目', np.status === 200 && np.json.id);
  const opPid = np.json.id;
  check('项目归属为子账号', np.json.ownerId === opId, 'ownerId=' + np.json.ownerId);

  const opProjects2 = (await op.get('/api/projects')).json;
  check('子账号只看到自己的 1 个项目', opProjects2.length === 1 && opProjects2[0].id === opPid);
  const ownerAll = (await owner.get('/api/projects')).json;
  check('主账号能看到子账号的项目（含归属名）', ownerAll.some(p => p.id === opPid && p.ownerName), JSON.stringify(ownerAll.map(p => p.ownerName)));

  // ---------- 5. 越权访问 ----------
  const ownerPid = ownerProjects[0].id;
  const cross = await op.get('/api/projects/' + ownerPid);
  check('子账号访问他人项目返回 403', cross.status === 403, 'code=' + cross.status);
  const crossRender = await op.post('/api/projects/' + ownerPid + '/render', {});
  check('子账号对他人项目发起渲染被拒', crossRender.status === 403, 'code=' + crossRender.status);
  const crossDel = await op.del('/api/projects/' + ownerPid);
  check('子账号删除他人项目被拒', crossDel.status === 403, 'code=' + crossDel.status);

  const teamByOp = await op.get('/api/team/overview');
  check('子账号访问团队管理返回 403', teamByOp.status === 403, 'code=' + teamByOp.status);
  const createByOp = await op.post('/api/team/users', { username: 'hack', account: 'hack' + suffix, password: '123456' });
  check('子账号创建账号被拒（不能自己开号）', createByOp.status === 403, 'code=' + createByOp.status);

  // 子账号自己的项目可正常访问
  const self = await op.get('/api/projects/' + opPid);
  check('子账号可访问自己的项目', self.status === 200 && self.json.id === opPid);

  // ---------- 6. 主账号按运营查看 ----------
  const scopedProjects = (await owner.get('/api/projects?user=' + opId)).json;
  check('主账号 ?user= 只看该运营项目', scopedProjects.length === 1 && scopedProjects[0].id === opPid);
  const scopedStats = (await owner.get('/api/stats?user=' + opId)).json;
  check('主账号 ?user= 统计只算该运营', scopedStats.projectCount === 1, JSON.stringify(scopedStats));
  const ov = (await owner.get('/api/team/overview')).json;
  const row = (ov.rows || []).find(r => r.user.id === opId);
  check('团队概览含该运营且字段齐全', !!row && row.stats.todayProjects === 1 && typeof row.todayVideoCount === 'number',
    JSON.stringify(row && { tp: row.stats.todayProjects, tv: row.todayVideoCount, run: row.runningCount }));

  // ---------- 7. 停用 / 启用 ----------
  const dis = await owner.patch('/api/team/users/' + opId, { disabled: true });
  check('主账号可停用子账号', dis.status === 200 && dis.json.disabled === true);
  const opLoginBlocked = await client().post('/api/auth/login', { account: acc, password: 'op123456' });
  check('停用后不能登录', opLoginBlocked.status === 401, JSON.stringify(opLoginBlocked.json));
  const opApiBlocked = await op.get('/api/projects');
  check('停用后旧会话立即失效', opApiBlocked.status === 401, 'code=' + opApiBlocked.status);

  await owner.patch('/api/team/users/' + opId, { disabled: false });
  const opBack = await client().post('/api/auth/login', { account: acc, password: 'op123456' });
  check('启用后可重新登录', opBack.status === 200);

  // ---------- 8. 重置密码 ----------
  await owner.patch('/api/team/users/' + opId, { password: 'newpass888' });
  const oldPwd = await client().post('/api/auth/login', { account: acc, password: 'op123456' });
  check('重置后旧密码失效', oldPwd.status === 401);
  const newPwd = await client().post('/api/auth/login', { account: acc, password: 'newpass888' });
  check('重置后新密码可登录', newPwd.status === 200);

  // ---------- 9. 主账号不可被停用/删除 ----------
  const ownerDisable = await owner.patch('/api/team/users/usr_owner', { disabled: true });
  check('主账号不可被停用', ownerDisable.status === 400, JSON.stringify(ownerDisable.json));
  const ownerDelete = await owner.del('/api/team/users/usr_owner');
  check('主账号不可被删除', ownerDelete.status === 400);

  // ---------- 10. 删除子账号 -> 项目转移给主账号 ----------
  const delRes = await owner.del('/api/team/users/' + opId);
  check('删除子账号成功', delRes.status === 200 && delRes.json.ok, JSON.stringify(delRes.json));
  check('删除时把项目转移给主账号', delRes.json.movedProjects === 1, 'moved=' + delRes.json.movedProjects);
  const ownerAfter = (await owner.get('/api/projects/' + opPid)).json;
  check('转移后主账号可访问原运营项目', ownerAfter.ownerId === 'usr_owner', 'ownerId=' + ownerAfter.ownerId);

  // 清理测试项目
  await owner.del('/api/projects/' + opPid);

  // ---------- 11. 退出登录 ----------
  await owner.post('/api/auth/logout');
  const afterLogout = await owner.get('/api/auth/me');
  check('退出后会话失效', afterLogout.status === 401, 'code=' + afterLogout.status);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
