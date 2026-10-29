// test/extra.js - 校验 编辑重生成 / 素材与视频属性修改 / 页面可访问
const BASE = 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u){ return (await fetch(BASE+u)).json(); }
async function post(u,b){ return (await fetch(BASE+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})})).json(); }
async function patch(u,b){ return (await fetch(BASE+u,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})})).json(); }

(async()=>{
  // 取最近一个含视频的项目
  const list = await get('/api/projects');
  const p = list.find(x=>x.videoCount>0);
  if(!p){ console.log('没有含视频的项目，跳过'); process.exit(0); }
  console.log('使用项目:', p.id, p.name);

  // 1) 素材属性修改
  const proj = await get('/api/projects/'+p.id);
  const mat = proj.materials.find(m=>m.type==='video');
  const mp = await patch(`/api/projects/${p.id}/materials/${mat.id}`, { category:'细节特写', required:true });
  console.log('素材修改:', mp.category, '必用=', mp.required);

  // 2) 视频锁定 + 重命名
  const v = proj.videos[0];
  const vp = await patch(`/api/projects/${p.id}/videos/${v.id}`, { locked:true, rename:'锁定测试标题' });
  console.log('视频修改: locked=', vp.locked, 'title=', vp.title);

  // 3) 单条重新生成（改标题 + 静音）
  const segs = v.segments.map(s=>({materialId:s.materialId,type:s.type,srcStart:s.srcStart,srcDur:s.srcDur,category:s.category,sellPoint:s.sellPoint}));
  const beforeCount = proj.videos.length;
  const r = await post(`/api/projects/${p.id}/render`, { single:v.version, videoId:v.id, overrides:{ title:'编辑后标题·静音版', segments:segs, music:'none' } });
  console.log('触发单条重生成 taskId=', r.taskId);
  let task=null;
  for(let i=0;i<120;i++){ const pp=await get('/api/projects/'+p.id); task=pp.tasks.find(t=>t.id===r.taskId); if(task&&['done','error'].includes(task.status))break; await sleep(1000); }
  const after = await get('/api/projects/'+p.id);
  const nv = after.videos.find(x=>x.id===v.id);
  console.log('重生成结果: status=', task.status, '| 标题=', nv.title, '| 保持锁定=', nv.locked, '| 视频数(前/后)=', beforeCount+'/'+after.videos.length);

  // 4) 页面可访问
  for(const url of ['/index.html','/create.html','/project.html','/profile.html','/css/style.css','/js/common.js']){
    const res = await fetch(BASE+url);
    console.log('页面', url, '=>', res.status);
  }
  console.log('\n✅ 附加验证完成');
  process.exit(0);
})().catch(e=>{ console.error('❌',e); process.exit(1); });
