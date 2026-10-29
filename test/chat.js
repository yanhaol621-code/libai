// test/chat.js - 在线状态 / 私聊消息 / 文件传输 / 主账号聊天记录审计 端到端测试
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    async upload(p, buf, type, filename, fields) {
      const form = new FormData();
      form.append('file', new Blob([buf], { type }), filename || 'a.txt');
      for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
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
      return { status: r.status, type: r.headers.get('content-type') || '', text: buf.toString('utf8'), size: buf.length };
    },
    get cookie() { return cookie; },
  };
}

(async () => {
  const owner = client();
  const a = client();
  const b = client();
  const c = client();
  const suffix = Date.now().toString().slice(-6);
  const accA = 'chatA' + suffix, accB = 'chatB' + suffix, accC = 'chatC' + suffix;
  let opA = null, opB = null, opC = null;

  const login = await owner.post('/api/auth/login', { account: '15954896689', password: '789215' });
  check('主账号登录', login.status === 200 && !!login.json.user, JSON.stringify(login.json).slice(0, 120));
  const ownerId = login.json.user.id;

  // ---------- 1. 建三个测试账号 ----------
  const mk = async (name, acc, level, manageLevel) => owner.post('/api/team/users', { username: name, account: acc, password: 'chat123456', level, manageLevel });
  opA = (await mk('聊天测试A' + suffix, accA, 'P5', 'M1')).json;
  opB = (await mk('聊天测试B' + suffix, accB, 'P2')).json;
  opC = (await mk('聊天测试C' + suffix, accC, 'P3')).json;
  check('创建三个测试账号', !!opA && !!opB && !!opC, JSON.stringify([opA, opB, opC]).slice(0, 120));

  await a.post('/api/auth/login', { account: accA, password: 'chat123456' });
  await b.post('/api/auth/login', { account: accB, password: 'chat123456' });
  await c.post('/api/auth/login', { account: accC, password: 'chat123456' });

  // ---------- 2. 登录即在线 ----------
  const presA = await a.get('/api/presence');
  const pA = presA.json.users[opA.id], pOwner = presA.json.users[ownerId];
  check('登录后自己显示在线', !!pA && pA.online === true && pA.status === 'online', JSON.stringify(pA));
  check('同事登录后也能看到主账号在线', !!pOwner && pOwner.online === true, JSON.stringify(pOwner));
  check('在线状态带 onlineSince 与 lastSeenAt',
    !!pA.onlineSince && !!pA.lastSeenAt, JSON.stringify({ s: pA.onlineSince, l: pA.lastSeenAt }));

  const ping = await a.post('/api/presence/ping');
  check('心跳接口保持在线', ping.status === 200 && ping.json.me.online === true, JSON.stringify(ping.json).slice(0, 120));

  // ---------- 3. 手动切换在线模式 ----------
  const busy = await a.post('/api/presence/status', { status: 'busy' });
  check('可切换为忙碌', busy.status === 200 && busy.json.me.status === 'busy');
  const viewBusy = await b.get('/api/presence');
  check('其他账号看到忙碌状态', viewBusy.json.users[opA.id].status === 'busy' &&
    viewBusy.json.users[opA.id].statusText === '忙碌', JSON.stringify(viewBusy.json.users[opA.id]));
  const badStatus = await a.post('/api/presence/status', { status: 'sleeping' });
  check('非法在线状态被拒', badStatus.status === 400, String(badStatus.status));
  await a.post('/api/presence/status', { status: 'online' });

  // ---------- 4. 同事列表 ----------
  const usersForB = await b.get('/api/chat/users');
  const rowA = (usersForB.json.users || []).find((x) => x.user.id === opA.id);
  check('同事列表带在线状态与上次登录', !!rowA && rowA.presence.online === true && !!rowA.user.lastLoginAt,
    JSON.stringify(rowA && { on: rowA.presence.online, ll: rowA.user.lastLoginAt }).slice(0, 140));
  check('同事列表不含自己', !(usersForB.json.users || []).some((x) => x.user.id === opB.id));

  // ---------- 5. 发文字消息 ----------
  const m1 = await a.post('/api/chat/messages', { to: opB.id, text: 'B，这份礼盒的封面图我放你桌上了' });
  check('A 给 B 发文字成功', m1.status === 200 && !!m1.json.message.id, JSON.stringify(m1.json).slice(0, 140));
  const unreadB = await b.get('/api/chat/users');
  const rowFromA = (unreadB.json.users || []).find((x) => x.user.id === opA.id);
  check('B 收到未读 +1', rowFromA && rowFromA.unread === 1 && unreadB.json.totalUnread >= 1,
    JSON.stringify({ u: rowFromA && rowFromA.unread, t: unreadB.json.totalUnread }));
  check('B 的会话预览是刚发的消息', rowFromA.last && rowFromA.last.text.indexOf('封面图') >= 0,
    JSON.stringify(rowFromA.last && rowFromA.last.text));

  const self = await a.post('/api/chat/messages', { to: opA.id, text: '给自己发' });
  check('不能给自己发消息', self.status === 400, JSON.stringify(self.json).slice(0, 100));
  const empty = await a.post('/api/chat/messages', { to: opB.id, text: '   ' });
  check('空消息被拒', empty.status === 400, String(empty.status));
  const ghost = await a.post('/api/chat/messages', { to: 'usr_not_exist', text: '喂' });
  check('收件人不存在被拒', ghost.status === 404, String(ghost.status));

  const longText = '长'.repeat(2500);
  const mLong = await a.post('/api/chat/messages', { to: opB.id, text: longText });
  check('超长文本自动截断到 2000 字',
    mLong.status === 200 && mLong.json.message.text.length === 2000, String(mLong.json.message && mLong.json.message.text.length));

  // ---------- 6. 拉取与已读 ----------
  const hist = await b.get('/api/chat/messages?with=' + opA.id);
  check('B 能拉到与 A 的会话（两条）', hist.status === 200 && hist.json.messages.length === 2,
    String(hist.json.messages && hist.json.messages.length));
  check('会话返回对方资料与在线状态', !!hist.json.peer && hist.json.peer.manageLevel === 'M1' && hist.json.peer.level === 'P5' && !!hist.json.presence,
    JSON.stringify(hist.json.peer && [hist.json.peer.manageLevel, hist.json.peer.level]));
  check('消息按时间升序', hist.json.messages[0].at <= hist.json.messages[1].at);

  const readRes = await b.post('/api/chat/read', { peer: opA.id });
  check('B 标记已读返回条数', readRes.status === 200 && readRes.json.read === 2, JSON.stringify(readRes.json));
  check('已读后未读数归零', readRes.json.totalUnread === 0, String(readRes.json.totalUnread));
  const histAfter = await a.get('/api/chat/messages?with=' + opB.id);
  check('发送方看到已读时间', histAfter.json.messages.every((m) => !!m.readAt),
    JSON.stringify(histAfter.json.messages.map((m) => !!m.readAt)));

  const crossRead = await c.get('/api/chat/messages?with=' + opA.id);
  check('第三人只能看到自己与 A 的会话（空）', crossRead.status === 200 && crossRead.json.messages.length === 0,
    String(crossRead.json.messages.length));

  // ---------- 7. 文件传输 ----------
  const buf = Buffer.from('礼盒封面设计稿 v3\r\n尺寸 1080x1920', 'utf8');
  const up = await a.upload('/api/chat/upload', buf, 'text/plain', '礼盒封面 设计稿.txt', { to: opB.id, text: '封面稿在这' });
  check('A 给 B 传文件成功', up.status === 200 && !!up.json.message.file, JSON.stringify(up.json).slice(0, 160));
  check('附件保留中文文件名', up.json.message.file.name === '礼盒封面 设计稿.txt', up.json.message.file.name);
  check('附件大小正确', up.json.message.file.size === buf.length, String(up.json.message.file.size));

  const dlB = await b.raw('/api/chat/files/' + up.json.message.file.id);
  check('B 能下载附件且内容一致', dlB.status === 200 && dlB.text.indexOf('1080x1920') >= 0,
    `${dlB.status} ${dlB.text.slice(0, 40)}`);
  const dlOwner = await owner.raw('/api/chat/files/' + up.json.message.file.id);
  check('主账号可下载任意附件（审计）', dlOwner.status === 200, String(dlOwner.status));
  const dlC = await c.raw('/api/chat/files/' + up.json.message.file.id);
  check('无关账号下载附件被拒 403', dlC.status === 403, String(dlC.status));
  const dlGhost = await a.raw('/api/chat/files/file_not_exist');
  check('不存在的文件返回 404', dlGhost.status === 404, String(dlGhost.status));

  const upNoTo = await a.upload('/api/chat/upload', buf, 'text/plain', 'x.txt', {});
  check('传文件缺收件人被拒', upNoTo.status === 400, String(upNoTo.status));

  // ---------- 8. 实时推送（SSE） ----------
  let sseBuf = '';
  async function readEvent(reader, timeout) {
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeout); });
    const next = (async () => {
      while (true) {
        let idx;
        while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
          const evt = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          const line = evt.split('\n').find((l) => l.startsWith('data:'));
          if (line) return JSON.parse(line.slice(5).trim());
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('closed');
        sseBuf += Buffer.from(value).toString('utf8');
      }
    })();
    try { return await Promise.race([deadline, next]); }
    finally { clearTimeout(timer); }
  }

  const ac = new AbortController();
  const sse = await fetch(BASE + '/api/chat/stream', { headers: { Cookie: b.cookie }, signal: ac.signal });
  check('SSE 通道可建立', sse.status === 200 && /text\/event-stream/.test(sse.headers.get('content-type') || ''),
    sse.headers.get('content-type'));
  const reader = sse.body.getReader();
  const ready = await readEvent(reader, 6000);
  check('SSE 首帧带在线快照与未读数', ready.type === 'ready' && !!ready.users && typeof ready.totalUnread === 'number',
    JSON.stringify(Object.keys(ready)));
  await a.post('/api/chat/messages', { to: opB.id, text: '实时推送测试' });
  const pushed = await readEvent(reader, 8000);
  check('对方在线时消息实时推送', pushed.type === 'chat' && pushed.message.text === '实时推送测试',
    JSON.stringify(pushed).slice(0, 160));
  check('未知账号不能建立 SSE 之外的越权访问', (await c.get('/api/chat/audit')).status === 403);
  ac.abort();

  // ---------- 9. 主账号聊天记录审计 ----------
  const audit = await owner.get('/api/chat/audit');
  check('主账号能看全部会话', audit.status === 200 && Array.isArray(audit.json.rows));
  const pair = (audit.json.rows || []).find((r) =>
    (r.a.id === opA.id && r.b.id === opB.id) || (r.a.id === opB.id && r.b.id === opA.id));
  check('审计里有 A ↔ B 的会话', !!pair, JSON.stringify((audit.json.rows || []).length));
  check('审计统计消息数与文件数', pair.count === 4 && pair.files === 1, JSON.stringify({ c: pair && pair.count, f: pair && pair.files }));
  check('审计统计里含活跃成员数', audit.json.stats.participants >= 2, JSON.stringify(audit.json.stats));

  const auditMsgs = await owner.get(`/api/chat/audit/messages?a=${opA.id}&b=${opB.id}`);
  check('主账号能读任意两人完整记录', auditMsgs.status === 200 && auditMsgs.json.messages.length === 4,
    String(auditMsgs.json.messages && auditMsgs.json.messages.length));
  check('审计记录带双方资料', auditMsgs.json.a.manageLevel === 'M1' && auditMsgs.json.a.level === 'P5' && auditMsgs.json.b.level === 'P2', JSON.stringify([auditMsgs.json.a.levelText, auditMsgs.json.b.levelText]));

  const denied = await a.get('/api/chat/audit');
  check('子账号访问审计接口被拒', denied.status === 403, String(denied.status));
  const deniedMsgs = await a.get(`/api/chat/audit/messages?a=${opB.id}&b=${opC.id}`);
  check('子账号读他人记录被拒', deniedMsgs.status === 403, String(deniedMsgs.status));
  const deniedExport = await a.get(`/api/chat/audit/export?a=${opB.id}&b=${opC.id}`);
  check('子账号导出记录被拒', deniedExport.status === 403, String(deniedExport.status));

  const exp = await owner.raw(`/api/chat/audit/export?a=${opA.id}&b=${opB.id}`);
  check('导出文本包含消息与文件', exp.status === 200 && exp.text.indexOf('封面图') >= 0 && exp.text.indexOf('[文件]') >= 0,
    exp.text.slice(0, 60));

  // ---------- 10. 退出登录 / 离线 ----------
  const beforeLogout = await b.get('/api/presence');
  check('退出前 B 为在线', beforeLogout.json.users[opB.id].online === true);
  await b.post('/api/auth/logout');
  await sleep(220);
  const afterLogout = await a.get('/api/presence');
  const pB2 = afterLogout.json.users[opB.id];
  check('退出登录后立即变为离线', pB2.online === false && pB2.status === 'offline', JSON.stringify(pB2));
  check('离线后仍有最近在线时间可供显示', !!pB2.lastSeenAt, JSON.stringify(pB2));
  const relogin = await b.post('/api/auth/login', { account: accB, password: 'chat123456' });
  check('重新登录恢复在线', relogin.status === 200 &&
    (await a.get('/api/presence')).json.users[opB.id].online === true);

  // ---------- 11. 删除账号连带清理聊天 ----------
  const delRes = await owner.del('/api/team/users/' + opC.id);
  check('删除测试账号 C', delRes.status === 200, JSON.stringify(delRes.json).slice(0, 100));
  await owner.del('/api/team/users/' + opB.id);
  const auditAfter = await owner.get('/api/chat/audit');
  const pairAfter = (auditAfter.json.rows || []).find((r) => r.a.id === opA.id || r.b.id === opA.id);
  check('删除账号后其会话从审计中清除', !pairAfter, JSON.stringify(pairAfter && pairAfter.key));

  await owner.del('/api/team/users/' + opA.id);
  const finalAudit = await owner.get('/api/chat/audit');
  check('三个测试账号的会话全部清理干净',
    !(finalAudit.json.rows || []).some((r) => [opA.id, opB.id, opC.id].includes(r.a.id) || [opA.id, opB.id, opC.id].includes(r.b.id)),
    JSON.stringify((finalAudit.json.rows || []).map((r) => r.key)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
