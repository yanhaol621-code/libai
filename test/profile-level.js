// test/profile-level.js - 个人资料（头像/昵称/用户名不可改）与职级分配端到端测试
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

function client() {
  let cookie = '';
  async function req(method, p, body) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setC) {
      const kv = c.split(';')[0];
      if (kv.startsWith('sid=')) cookie = kv;
    }
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b || {}),
    patch: (p, b) => req('PATCH', p, b || {}),
    del: (p) => req('DELETE', p),
    async upload(p, buf, type, filename) {
      const form = new FormData();
      form.append('file', new Blob([buf], { type }), filename || 'a.webp');
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      const r = await fetch(BASE + p, { method: 'POST', headers, body: form });
      let json = null;
      try { json = await r.json(); } catch (_) {}
      return { status: r.status, json };
    },
    async raw(p) {
      const headers = {};
      if (cookie) headers.Cookie = cookie;
      const r = await fetch(BASE + p, { headers });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, type: r.headers.get('content-type') || '', size: buf.length, buf };
    },
    get cookie() { return cookie; },
  };
}

(async () => {
  const owner = client();
  const a = client();
  const b = client();
  const suffix = Date.now().toString().slice(-6);
  const accA = 'lvlA' + suffix;
  const accB = 'lvlB' + suffix;
  let opA = null, opB = null;

  // ---------- 0. 主账号职级（两条独立通道） ----------
  const lo = await owner.post('/api/auth/login', { account: '15954896689', password: '789215' });
  check('主账号登录成功', lo.status === 200 && lo.json.user.role === 'owner', JSON.stringify(lo.json));
  const ownerMe = lo.json.user;
  check('主账号管理岗为合法 M 级', ['M1','M2','M3','M4'].indexOf(ownerMe.manageLevel) >= 0 && !!ownerMe.manageName, JSON.stringify({ m: ownerMe.manageLevel, n: ownerMe.manageName }));
  check('主账号专业职级字段存在（可为空）', ownerMe.level === null || /^P\d$/.test(ownerMe.level || ''), JSON.stringify(ownerMe.level));
  check('主账号 isManager=true', ownerMe.isManager === true && ownerMe.canAssignLevel === true, JSON.stringify({ m: ownerMe.isManager, c: ownerMe.canAssignLevel }));
  check('主账号可分配 9 个专业职级 + 4 个管理职级',
    ownerMe.assignableLevels.length === 9 && ownerMe.assignableManageLevels.length === 4,
    JSON.stringify([ownerMe.assignableLevels, ownerMe.assignableManageLevels]));

  // ---------- 1. 职级目录 ----------
  const lv = await owner.get('/api/team/levels');
  check('职级目录共 13 档（P9 + M4）', lv.status === 200 && lv.json.levels.length === 13, 'len=' + (lv.json.levels || []).length);
  check('目录拆成 professional / management 两组', (lv.json.professional || []).length === 9 && (lv.json.management || []).length === 4,
    JSON.stringify([(lv.json.professional || []).length, (lv.json.management || []).length]));
  check('专业通道为 P0-P8，管理通道为 M1-M4',
    (lv.json.professional || []).map((l) => l.code).join(',') === 'P0,P1,P2,P3,P4,P5,P6,P7,P8' &&
    (lv.json.management || []).map((l) => l.code).join(',') === 'M1,M2,M3,M4',
    JSON.stringify([(lv.json.professional || []).map((l) => l.code), (lv.json.management || []).map((l) => l.code)]));

  // ---------- 2. 建两个子账号 ----------
  const cA = await owner.post('/api/team/users', { username: '职级测A' + suffix, account: accA, password: 'op123456', level: 'P1' });
  const cB = await owner.post('/api/team/users', { username: '职级测B' + suffix, account: accB, password: 'op123456', level: 'P3' });
  check('创建子账号 A（P1，无管理岗）成功', cA.status === 200 && cA.json.level === 'P1' && cA.json.manageLevel === null, JSON.stringify(cA.json));
  check('创建子账号 B（P3，无管理岗）成功', cB.status === 200 && cB.json.level === 'P3' && cB.json.manageLevel === null, JSON.stringify(cB.json));
  opA = cA.json; opB = cB.json;

  check('P1 账号 canAssignLevel=false', cA.json.canAssignLevel === false, String(cA.json.canAssignLevel));
  check('P3 账号 isManager=false', cB.json.isManager === false, String(cB.json.isManager));

  const la = await a.post('/api/auth/login', { account: accA, password: 'op123456' });
  const lb = await b.post('/api/auth/login', { account: accB, password: 'op123456' });
  check('A / B 登录成功', la.status === 200 && lb.status === 200, JSON.stringify([la.json.error, lb.json.error]));

  // ---------- 3. 普通 P 岗无权看团队概览 ----------
  const aOverview = await a.get('/api/team/overview');
  check('P1 访问团队概览返回 403', aOverview.status === 403, 'code=' + aOverview.status);
  const aAssign = await a.patch('/api/team/users/' + opB.id + '/level', { level: 'P4' });
  check('P1 分配职级返回 403', aAssign.status === 403, 'code=' + aAssign.status);

  // ---------- 4. 主账号把 A 加为 M2 管理岗（不动专业职级） ----------
  const upA = await owner.patch('/api/team/users/' + opA.id + '/level', { manageLevel: 'M2' });
  check('主账号给 A 加管理岗 M2 成功', upA.status === 200 && upA.json.user.manageLevel === 'M2' && upA.json.user.manageName === '经理', JSON.stringify(upA.json && upA.json.user && { m: upA.json.user.manageLevel }));
  check('加管理岗不影响专业职级', upA.json.user.level === 'P1', JSON.stringify(upA.json.user && upA.json.user.level));
  check('返回管理岗变更前后值', upA.json.before === null && upA.json.after === 'M2', JSON.stringify({ b: upA.json.before, a: upA.json.after }));

  const aMe = await a.get('/api/auth/me');
  check('A 有管理岗后 canAssignLevel=true', aMe.json.user.canAssignLevel === true && aMe.json.user.isManager === true, JSON.stringify(aMe.json.user.canAssignLevel));
  check('M2+P1 可分配专业职级为 P0-P1', JSON.stringify(aMe.json.user.assignableLevels) === JSON.stringify(['P0','P1']), JSON.stringify(aMe.json.user.assignableLevels));
  check('M2 可分配管理职级为 M1-M2', JSON.stringify(aMe.json.user.assignableManageLevels) === JSON.stringify(['M1','M2']), JSON.stringify(aMe.json.user.assignableManageLevels));
  check('levelText 同时给出两条通道', aMe.json.user.levelText === 'M2 · P1', aMe.json.user.levelText);

  const aOverview2 = await a.get('/api/team/overview');
  check('M2 可查看团队概览', aOverview2.status === 200 && Array.isArray(aOverview2.json.rows) && aOverview2.json.rows.length >= 3, 'code=' + aOverview2.status);
  check('团队概览带上两条通道字段', (aOverview2.json.rows || []).every((r) => 'level' in r.user && 'manageLevel' in r.user), JSON.stringify((aOverview2.json.rows || []).map((r) => r.user && [r.user.level, r.user.manageLevel])));

  // ---------- 5. 主账号把 A 提到 P4（专业职级决定能给别人的上限） ----------
  const bumpA = await owner.patch('/api/team/users/' + opA.id + '/level', { level: 'P4' });
  check('主账号把 A 的专业职级提到 P4（管理岗仍是 M2）', bumpA.status === 200 && bumpA.json.user.level === 'P4' && bumpA.json.user.manageLevel === 'M2',
    JSON.stringify(bumpA.json && bumpA.json.user && { p: bumpA.json.user.level, m: bumpA.json.user.manageLevel }));
  const aMe2 = await a.get('/api/auth/me');
  check('M2+P4 可分配专业职级为 P0-P4', JSON.stringify(aMe2.json.user.assignableLevels) === JSON.stringify(['P0','P1','P2','P3','P4']), JSON.stringify(aMe2.json.user.assignableLevels));

  // ---------- 5.1 M2（P4）给 B 调整两条通道 ----------
  const toP2 = await a.patch('/api/team/users/' + opB.id + '/level', { level: 'P2' });
  check('M2（P4）可把 B 的专业职级调为 P2', toP2.status === 200 && toP2.json.user.level === 'P2', JSON.stringify(toP2.json && toP2.json.user && toP2.json.user.level));
  const toP5 = await a.patch('/api/team/users/' + opB.id + '/level', { level: 'P5' });
  check('M2（P4）不能把 B 调为 P5（专业职级越权）', toP5.status === 400, 'code=' + toP5.status + ' ' + JSON.stringify(toP5.json));
  const toM1 = await a.patch('/api/team/users/' + opB.id + '/level', { manageLevel: 'M1' });
  check('M2 可把 B 设为 M1 管理岗', toM1.status === 200 && toM1.json.user.manageLevel === 'M1', JSON.stringify(toM1.json && toM1.json.user && toM1.json.user.manageLevel));
  check('设管理岗不影响 B 的专业职级', toM1.json.user.level === 'P2', toM1.json.user.level);
  const toM3 = await a.patch('/api/team/users/' + opB.id + '/level', { manageLevel: 'M3' });
  check('M2 不能把 B 设为 M3（管理职级越权）', toM3.status === 400, 'code=' + toM3.status + ' ' + JSON.stringify(toM3.json));
  const badLevel = await a.patch('/api/team/users/' + opB.id + '/level', { level: 'P9' });
  check('非法专业职级返回 400', badLevel.status === 400, 'code=' + badLevel.status);
  const badManage = await a.patch('/api/team/users/' + opB.id + '/level', { manageLevel: 'M9' });
  check('非法管理职级返回 400', badManage.status === 400, 'code=' + badManage.status);
  const crossChannel = await a.patch('/api/team/users/' + opB.id + '/level', { level: 'M2' });
  check('专业职级不接受 M 代码', crossChannel.status === 400, 'code=' + crossChannel.status);
  const noKind = await a.patch('/api/team/users/' + opB.id + '/level', {});
  check('两个通道都不给返回 400', noKind.status === 400, 'code=' + noKind.status);
  const selfLevel = await a.patch('/api/team/users/' + opA.id + '/level', { level: 'P8' });
  check('管理岗不能调整自己', selfLevel.status === 400, 'code=' + selfLevel.status + ' ' + JSON.stringify(selfLevel.json));
  const ownerLevel = await a.patch('/api/team/users/usr_owner/level', { level: 'P1' });
  check('管理岗不能调整主账号', ownerLevel.status === 400, 'code=' + ownerLevel.status);

  // ---------- 5.5 主账号可同时持有两条通道（结束会还原成进来时的值） ----------
  const ownerBefore = (await owner.get('/api/auth/me')).json.user;
  const origM = ownerBefore.manageLevel;
  const origP = ownerBefore.level;
  const selfP = await owner.patch('/api/team/users/usr_owner/level', { level: 'P7' });
  check('主账号给自己设专业职级 P7', selfP.status === 200 && selfP.json.user.level === 'P7' && selfP.json.user.levelName === '高级专家', JSON.stringify(selfP.json && selfP.json.user && selfP.json.user.level));
  check('改专业职级不影响原有管理岗', selfP.json.user.manageLevel === origM, JSON.stringify({ now: selfP.json.user.manageLevel, was: origM }));
  check('主账号 levelText 同时给出两条通道', selfP.json.user.levelText === [origM, 'P7'].filter(Boolean).join(' · '), selfP.json.user.levelText);
  const otherM = origM === 'M2' ? 'M3' : 'M2';
  const selfM = await owner.patch('/api/team/users/usr_owner/level', { manageLevel: otherM });
  check('主账号可单独改管理岗', selfM.status === 200 && selfM.json.user.manageLevel === otherM && selfM.json.user.level === 'P7', JSON.stringify(selfM.json.user && { m: selfM.json.user.manageLevel, p: selfM.json.user.level }));
  check('主账号恒为管理岗', selfM.json.user.isManager === true && selfM.json.user.canAssignLevel === true, JSON.stringify(selfM.json.user && selfM.json.user.isManager));
  const clearM = await owner.patch('/api/team/users/usr_owner/level', { manageLevel: '' });
  check('主账号可清空管理岗（角色仍是管理岗）', clearM.status === 200 && clearM.json.user.manageLevel === null && clearM.json.user.isManager === true, JSON.stringify(clearM.json.user && { m: clearM.json.user.manageLevel, i: clearM.json.user.isManager }));
  const restoreM = await owner.patch('/api/team/users/usr_owner/level', { manageLevel: origM || '' });
  check('管理岗已还原', restoreM.status === 200 && restoreM.json.user.manageLevel === origM, JSON.stringify(restoreM.json.user && restoreM.json.user.manageLevel));
  const restoreP2 = await owner.patch('/api/team/users/usr_owner/level', { level: origP || '' });
  check('专业职级已还原', restoreP2.status === 200 && (restoreP2.json.user.level || null) === origP, JSON.stringify(restoreP2.json.user && restoreP2.json.user.level));

  // ---------- 6. M1 不能再动 M2 ----------
  const lb2 = await b.post('/api/auth/login', { account: accB, password: 'op123456' });
  check('B 升为 M1 后可看团队概览', (await b.get('/api/team/overview')).status === 200, '');
  const bPatchA = await b.patch('/api/team/users/' + opA.id + '/level', { manageLevel: 'M3' });
  check('M1 不能调整 M2 的管理层', bPatchA.status === 400, 'code=' + bPatchA.status + ' ' + JSON.stringify(bPatchA.json));
  const bPatchA2 = await b.patch('/api/team/users/' + opA.id + '/level', { level: 'P2' });
  check('M1（P0）不能给 M2 调专业职级', bPatchA2.status === 400, 'code=' + bPatchA2.status);

  // ---------- 7. 个人资料 ----------
  const prof = await a.patch('/api/auth/profile', { displayName: '职级测A改' + suffix, phone: '13800001234', bio: '专做食品包装' });
  check('本人可改昵称/手机号/签名', prof.status === 200 && prof.json.displayName === '职级测A改' + suffix && prof.json.phone === '13800001234' && prof.json.bio === '专做食品包装', JSON.stringify(prof.json && { d: prof.json.displayName, p: prof.json.phone, b: prof.json.bio }));
  check('改昵称不会动用户名', prof.json.username === '职级测A' + suffix, prof.json.username);

  const profName = await a.patch('/api/auth/profile', { displayName: '李白' });
  check('昵称重复被拒', profName.status === 400, 'code=' + profName.status + ' ' + JSON.stringify(profName.json));

  const profEmpty = await a.patch('/api/auth/profile', { displayName: '   ' });
  check('昵称不能为空', profEmpty.status === 400, 'code=' + profEmpty.status);

  const profBadPhone = await a.patch('/api/auth/profile', { phone: 'abc' });
  check('手机号格式校验生效', profBadPhone.status === 400, 'code=' + profBadPhone.status);

  const renameTry = await a.patch('/api/auth/profile', { username: 'hacker' + suffix });
  const afterRename = await a.get('/api/auth/me');
  check('资料接口无法修改用户名', renameTry.status === 200 && afterRename.json.user.username === '职级测A' + suffix, afterRename.json.user.username);

  const ownerRename = await owner.patch('/api/team/users/' + opA.id, { username: '改名试试' });
  check('团队接口也拒绝改用户名', ownerRename.status === 400 && /不可更改/.test(ownerRename.json.error || ''), JSON.stringify(ownerRename.json));

  const ownerNick = await owner.patch('/api/team/users/' + opA.id, { displayName: '主管A' + suffix });
  check('主账号可改成员昵称', ownerNick.status === 200 && ownerNick.json.displayName === '主管A' + suffix, JSON.stringify(ownerNick.json && ownerNick.json.displayName));

  // ---------- 8. 头像上传 / 读取 / 删除 ----------
  const imgPath = path.join(__dirname, '..', 'public', 'img', 'ip', 'maid-head.webp');
  const img = fs.readFileSync(imgPath);
  const up = await a.upload('/api/auth/avatar', img, 'image/webp', 'head.webp');
  check('上传头像成功', up.status === 200 && !!up.json.user.avatarUrl, JSON.stringify(up.json && up.json.error));
  const avUrl = up.json.user.avatarUrl;
  const got = await a.raw(avUrl);
  check('头像可读取（200 / image/webp）', got.status === 200 && /image\/webp/.test(got.type), got.status + ' ' + got.type);
  check('头像已裁成 240x240 且体积合理', got.size > 1000 && got.size < 200 * 1024, 'size=' + got.size);
  const avB = await b.raw('/api/users/' + opA.id + '/avatar?v=1');
  check('其他成员也能看到该头像', avB.status === 200, 'code=' + avB.status);

  const notImg = await a.upload('/api/auth/avatar', Buffer.from('not an image'), 'text/plain', 'a.txt');
  check('非图片上传被拒', notImg.status === 400, 'code=' + notImg.status);
  const fakeImg = await a.upload('/api/auth/avatar', Buffer.from('not an image'), 'image/png', 'a.png');
  check('伪装成图片的坏文件被拒', fakeImg.status === 400, 'code=' + fakeImg.status);
  check('坏文件不会覆盖已有头像', (await a.raw(avUrl)).status === 200, '');

  const delAv = await a.del('/api/auth/avatar');
  check('删除头像成功', delAv.status === 200 && !delAv.json.user.avatarUrl, JSON.stringify(delAv.json && delAv.json.user.avatarUrl));
  check('删除后头像地址 404', (await a.raw(avUrl)).status === 404, '');

  // ---------- 9. 团队概览里能看到头像与职级 ----------
  await a.upload('/api/auth/avatar', img, 'image/webp', 'head.webp');
  const ov = await owner.get('/api/team/overview');
  const rowA = (ov.json.rows || []).find((r) => r.user.id === opA.id);
  check('团队概览带成员头像与职级', !!rowA && !!rowA.user.avatarUrl && rowA.user.manageLevel === 'M2' && rowA.user.level === 'P4', JSON.stringify(rowA && { a: rowA.user.avatarUrl, m: rowA.user.manageLevel, l: rowA.user.level }));

  // ---------- 10. 权限页也带职级 ----------
  const perms = await owner.get('/api/team/permissions');
  const pA = (perms.json.rows || []).find((r) => r.id === opA.id);
  check('管理权限接口返回职级与管理岗标记', !!pA && pA.level === 'P4' && pA.manageLevel === 'M2' && pA.isManager === true, JSON.stringify(pA && { p: pA.level, m: pA.manageLevel, i: pA.isManager }));

  // ---------- 清理 ----------
  await owner.del('/api/team/users/' + opA.id);
  await owner.del('/api/team/users/' + opB.id);
  const finalList = await owner.get('/api/team/permissions');
  const leftovers = (finalList.json.rows || []).filter((r) => r.id === opA.id || r.id === opB.id);
  check('测试账号已清理', leftovers.length === 0, JSON.stringify(leftovers.map((r) => r.id)));
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'avatars', opA.id + '.webp')); } catch (_) {}

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
