# 电商·视频混剪工作台（第一阶段 MVP）

把同一产品的视频与图片拖进来，系统自动完成**素材分析 → 多版本混剪 → 字幕配乐 → MP4 导出**，用于抖音 / 淘宝 / 拼多多的电商短视频批量生产。

- 真实可用：真实分片上传、真实 FFmpeg 分析、真实渲染导出，不是 UI 原型。
- 同款隔离：每个产品单独建项目，只在本项目素材内混剪，跨产品需人工确认。
- 保护真实性：只对实拍素材做剪辑，不生成/篡改产品外观、印刷文案、Logo。

---

## 一、技术架构与选型理由

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node.js + Express | 与前端同源、单进程即可跑起来，部署简单；异步 IO 适合任务调度 |
| 上传 | 分片上传（5MB/片） | 支持大文件、真实进度、断点续传友好的协议 |
| 视频处理 | FFmpeg / ffprobe（内嵌 `bin/`） | 裁切/缩放/拼接/转场/字幕/混音/编码全能，成本低、可控 |
| 任务队列 | 进程内异步队列 + SSE | 渲染在后台进程执行，不阻塞网页；SSE 实时推送进度 |
| 存储 | 本地文件系统 + JSON 元数据 | 零外部依赖，便于本地/单机部署；结构清晰可迁移 |
| 打包下载 | archiver（ZIP） | 流式打包，不占内存 |
| AI | 可插拔接口 `server/lib/ai.js` | 第一阶段用启发式分析；后续可替换为视觉/语音大模型，不影响主流程 |

> 为什么不用前端剪辑库（如 webcodecs）：真实 1080×1920 多版本渲染、字幕合成、混音在浏览器端既慢又不稳；后端 FFmpeg 是成熟方案，且便于以后做成服务器排队渲染。

## 二、项目目录

```
混剪网站/
├── bin/                     内嵌 FFmpeg/ffprobe（含 DLL）与中文字体 bin/fonts/
├── server/
│   ├── index.js             Express 入口：REST API + SSE + 静态资源
│   ├── config.js            配置与路径解析（FFmpeg 路径、端口、数据目录）
│   └── lib/
│       ├── store.js         项目/素材/视频持久化 + 按项目互斥锁
│       ├── ffmpeg.js        FFmpeg/ffprobe 封装（并发限制、超时、黑屏/静音/运动/清晰度）
│       ├── analysis.js      素材分析（元数据、缩略图、质量检测、启发式分类）
│       ├── ai.js            可插拔 AI 接口（视觉分析占位 + 卖点/标题规则生成）
│       ├── editor.js        多版本剪辑方案生成（差异化策略 A~E）
│       ├── render.js        真实渲染管线（分段归一化→拼接→字幕/配乐合成→导出）
│       ├── tasks.js         异步任务队列 + 进度事件
│       ├── presence.js      在线状态（心跳/手动状态/SSE 实时推送）
│       └── chat.js          站内私聊与附件存储（JSON 原子写 + 审计）
├── public/                  前端（无构建步骤，原生 HTML/CSS/JS）
│   ├── index.html           首页（双栏 Hero / 五格统计条 / 最近项目）
│   ├── create.html          项目创建页
│   ├── project.html         工作台（上传/分析/混剪/结果/编辑/素材库）
│   ├── today.html           今日数据（今日新生成视频 / 进行中任务）
│   ├── team.html            团队管理（主账号 + M1-M4 管理岗，可分配职级）
│   ├── permissions.html     管理权限（仅主账号，按人授权）
│   ├── profile.html         我的资料（自设头像 / 昵称 / 手机号 / 签名 / 在线状态 / 改密码）
│   ├── chat.html            站内消息（同事在线状态 + 私聊 + 传文件）
│   ├── chat-audit.html      聊天记录（仅主账号：全部会话与导出）
│   ├── login.html           登录页（左 IP / 右表单分栏）
│   ├── img/ip/              IP 形象：maid.webp（整图）/ maid-head.webp（头像）
│   ├── css/style.css
│   └── js/common.js         API 封装、分片上传、SSE、顶栏身份区
├── test/
│   ├── fixtures/            测试素材（合成的真实视频/图片，含黑屏/静音样本）
│   ├── e2e.js               端到端测试
│   ├── auth.js              账号与权限隔离
│   ├── permissions.js       管理权限 / 按人授权「看全部视频」
│   ├── profile-level.js     个人资料（头像/用户名不可改）与职级分配权限
│   ├── chat.js              在线状态 / 私聊 / 文件传输 / 聊天记录审计
│   ├── ui-auth.js           登录页、导航、团队页、权限页 UI 流程
│   ├── ui-health.js         13 个页面探针 + 控制台异常 + 图片加载率
│   └── extra.js             编辑重生成/属性修改/页面可访问测试
├── data/                    运行时数据（项目、素材、产出、临时文件、音乐、头像、聊天）
├── .env.example             环境变量示例
├── package.json
└── README.md
```

## 三、数据模型（JSON）

- **Project**：`id / name / category / ratio / duration / count / style / subtitle / brand / materials[] / videos[] / tasks[]`
- **Material**：`id / filename / originalName / type(video|image) / duration / width / height / hasAudio / status / category / required / forbidden / usable / needsConfirm / quality{黑屏,静音,运动,清晰度} / problems[] / thumbnail`
- **Task**：`id / status(queued|planning|rendering|done|error) / progress / message / warnings[] / versions[]`
- **Video**：`id / taskId / version / label / title / hook / ending{main,sub} / template / path / thumbnail / duration / size / width / height / locked / segments[]`（`segments[].sellPoint` 即该镜头的短句字幕）
- **User**（`data/users.json`）：`id / username(不可改) / account(不可改) / password(scrypt) / role(owner|operator) / displayName / level(P0-P8,专业职级) / manageLevel(M1-M4,管理层，可为空) / avatar / avatarVersion / phone / bio / permissions{viewAllVideos} / disabled / createdAt / lastLoginAt / lastSeenAt`
- **ChatMessage**（`data/chat/state.json`）：`id / from / to / text / file{id,name,size,mime,storedName} / at / readAt`；附件落盘 `data/chat/files/`
- **Presence**（内存，重启后按用户 `lastSeenAt` 回落）：`online / status(online|busy|away) / onlineSince / lastSeen`

所有写操作通过 `store.withLock(projectId, fn)` 串行化，避免并发分析/渲染互相覆盖；账号库 `data/users.json` 的所有读-改-写（建号、删号、改职级、改资料、记录最近在线时间）都走 `auth.withDbWrite()` 的同一条队列，否则后台写「最近在线」会把旧快照写回去、把刚删掉的账号复活。

## 四、视频处理流程

1. **分析**：ffprobe 取时长/分辨率/音轨 → 生成缩略图 → `blackdetect` 黑屏、`silencedetect` 静音、`blend difference` 运动、`edgedetect` 清晰度 → 启发式归类（一律标记"需确认"）。
2. **排片**（`editor.js`）：先按**成片模板**（`templates.js`）决定镜头优先级与节奏，再叠加 A~E 版本差异（开场/顺序/轮转），素材不足明确告警，不靠重复镜头伪装。
3. **渲染**（`render.js`）：
   - 每个镜头归一化到目标比例（9:16/1:1/4:3/16:9），`scale+cover crop`，30fps，首尾轻微淡入淡出作转场；
   - `concat` 拼接；
   - 叠加**开场大字钩子**（前 2 秒）、**逐行居中的短句字幕**（一句一屏、每行独立高亮底框）与**片尾品牌卡**（品牌名 + 一句引导）；
   - `amix` 混入背景音乐（项目上传或系统示例音乐，循环到视频长度），音乐音量按模板压低（口播模板 0.12，纯展示 0.26）；
   - 导出 **MP4 / H.264 / AAC / yuv420p / faststart**，并生成视频缩略图。

### 成片模板（对齐同行爆款结构）

| 模板 | 结构 | 适用 |
|---|---|---|
| 同行爆款 · 口播带货 | 口播开场 → 产品/包装实拍 → 短句字幕 → 品牌片尾；音乐压到 0.12 让人声突出 | 有口播素材时 |
| 同行爆款 · 纯产品展示 | 产品全景开场 → 细节/包装/陈列快切（2.5 秒/镜） → 短句字幕 → 品牌片尾 | 只有产品实拍时 |
| 工厂实力 / 细节介绍 / 使用场景 / 快节奏 / 日常风 | 原有五种风格，同样走新字幕体系（节奏与镜头优先级不同） | 特殊选题 |

- **结构参数**在 `server/lib/templates.js`：镜头优先级、单镜时长上限、钩子/片尾时长、字号系数、字幕位置、音乐音量、是否压顶部标题。
- **文案**在 `ai.js#buildScript`：按类别生成 3-4 条开场钩子、8 条短句字幕、片尾主副文案，**只用用户已填的产品名/类别/品牌**，不编造尺寸、承重、头数等参数。
- **口播素材**：素材分类新增「口播讲解」，分析时有音轨且几乎不静音（`silenceRatio < 0.18`、时长 ≥ 3 秒）的视频会自动归到此类；口播模板会优先用它开场。
- 项目建好后可在「自动混剪」参数区**更换模板**（`PATCH /api/projects/:id`），重新生成即生效；**项目概览头右侧的「✏️ 编辑」按钮**可改类别 / 比例 / 时长 / 数量 / 成片模板（弹窗内时长、数量支持「自定义」，比例除 9:16/1:1/4:3/16:9 外也支持「自定义」宽:高如 3:4、2:3；非法比例会被拒、时长 5–300 / 数量 1–30 / 宽高 1–99 自动校验）；「视频编辑」页可单独改开场钩子、片尾主副文案与每段字幕后重渲单条。新建项目页同样支持比例「自定义」。
4. **进度**：任务队列通过 SSE 推送 `planning/rendering/done/error` 与百分比。

## 五、启动方法

> 环境要求：Node.js ≥ 18；Windows（本项目已在 Windows 验证，FFmpeg 已内嵌）。

```bash
# 1. 安装依赖
npm install

# 2. 启动（前端与后端同一服务，默认 3000 端口）
npm start
# 或：node server/index.js

# 3. 打开浏览器
http://localhost:3000
```

Windows 也可直接双击 `start.bat`（自动安装依赖并启动）。

### 首次登录（主账号）

| 项 | 值 |
|---|---|
| 用户名 | 李白 |
| 登录账号 | `15954896689` |
| 密码 | `789215` |

首次启动会自动创建该主账号（`data/users.json`，密码用 scrypt 加盐哈希存储）。**建议登录后到「我的资料 → 修改密码」改掉初始密码。**

主账号可在「团队管理」里创建运营子账号：

- 子账号自己用账号密码登录，只能看到 / 操作自己名下的项目，看不到别人和主账号的项目。
- 主账号可以看到全部项目，并可单独查看某个运营的：今日新建项目数、今日生成视频数、今日素材数、进行中任务，以及他的今日视频列表（`/team.html` → 对应成员卡片）。
- 「管理权限」、修改全局设置、创建/停用/删除账号只有主账号能做；「团队管理」主账号与 **M1-M4 管理岗**都可进入（管理岗只能看团队概览、分配不高于自己的职级），普通 P 岗直接调接口一律 403。
- 删除运营账号时，他名下的项目会自动转给主账号，不会丢数据。
- 删除项目时不会立刻物理删除：整个项目目录先被移到 `data/.trash/<项目ID>_<时间戳>/`，误删可直接把目录搬回 `data/projects/` 恢复。回收站不会自动清理，确认无用后再手动删。

### 管理权限（主账号专属）

导航里的「管理权限」（`/permissions.html`）是独立于「团队管理」的权限面板，只有主账号可见、可操作。两级角色的默认可见范围：

| 角色 | 项目 | 今日新生成视频 | 进行中任务 |
|---|---|---|---|
| 主账号 | 全部成员 | 全部成员 | 全部成员（可 `?user=` 筛选） |
| 运营（默认） | 仅自己 | 仅自己 | 仅自己 |
| 运营（已授权「可看全部视频」） | 仅自己 | **全部成员（只读）** | 仅自己 |

- 权限项为**按人单独开关**：`permissions.viewAllVideos`，默认 `false`；在「管理权限」页打开开关即时生效，被授权的运营无需重新登录。
- 授权后该运营在「今日数据 → 今日新生成视频」能看到并**播放 / 下载**全部成员的成品视频，也可一键 ZIP 打包；但**不能进入他人项目**、不能修改或删除他人视频（`/api/projects/:id` 等写接口仍 403）。
- 首页统计、项目列表、素材库、进行中任务始终按「自己的」计算，避免把别人的产出算进自己的 KPI。
- 接口：`GET /api/team/permissions`（权限总览）、`PATCH /api/team/users/:uid` 传 `{ "permissions": { "viewAllVideos": true } }`（或顶层 `viewAllVideos`）授权/收回；主账号自身权限不可被修改。

会话使用 `HttpOnly + SameSite=Lax` 的签名 Cookie（HMAC-SHA256，密钥存 `data/.session-secret`），默认 7 天有效；子账号被停用后旧的登录态立即失效。

### 职级与个人资料

**两条独立的职级通道**（可同时拥有，例如「M2 兼 P7」）：

| 通道 | 字段 | 职级 |
|---|---|---|
| 专业职级 | `level` | P0 实习 · P1 助理 · P2 初级 · P3 中级 · P4 高级 · P5 资深 · P6 专家 · P7 高级专家 · P8 首席 |
| 管理层 | `manageLevel` | M1 主管 · M2 经理 · M3 总监 · M4 总经理（留空 = 不带管理岗） |

- 两条通道各自比较档次，**互不换算**：管理层决定「谁管谁 / 谁能改职级」，专业职级体现专业水平。徽章上管理层为金色、专业职级为蓝色，两者都没有时显示灰色「未定级」。
- 新建账号默认专业职级 `P1`、无管理岗；主账号默认 `M4`、专业职级留空。启动时会自动迁移老数据（旧的单一 `level` 若为 M 开头则搬进 `manageLevel`）。
- **谁能调整**：主账号可调整任何人的两条通道（包括自己的）；管理岗只能调整**不高于自己**的同通道职级（M2 兼 P4 就能把成员设到 P4 以内、M2 以内），且不能调整该通道高于自己的成员、不能调整自己的职级（防自我提级）。主账号改职级不改变角色权限（仍是主账号、仍是管理岗）。
- 入口在「团队管理」成员卡片的两个下拉（职级 / 管理层），改完即时生效，并记录 `levelUpdatedAt / levelUpdatedBy`。
- 职级**不改变数据权限**（数据范围仍由角色与 `viewAllVideos` 决定），只用于团队识别与「谁管谁」；「团队管理」页主账号与管理岗都可打开，管理岗看不到新建账号 / 重置密码 / 停用删除 / 管理权限。

**个人资料**（`/profile.html`，点右上角身份胶囊进入）：

- 本人可改：**头像、昵称、手机号、个人签名**；主账号也可在「团队管理」里替成员改昵称。
- **用户名与登录账号不可更改**：`PATCH /api/team/users/:uid` 传 `username` 直接 400，资料接口也不接收该字段，保证团队列表里认人一致。
- 头像上传走 `POST /api/auth/avatar`（multipart，字段 `file`，≤8MB）：服务端用 FFmpeg 居中裁方 + 缩放到 **240×240 WebP**（约 15KB），存 `data/avatars/<uid>.webp`；URL 带 `?v=` 版本号，换头像立即刷新（带缓存头，不影响二次加载速度）。`DELETE /api/auth/avatar` 恢复默认字母头像。
- 没有头像时统一用昵称首字的渐变头像，视觉与原有 UI 一致。

### 在线状态与站内消息

**在线状态（登录即在线）**

- 登录成功即置为**在线**；页面每 25 秒心跳一次，并保持一条 SSE（`/api/chat/stream`）。
- 关闭页面或长时间无操作：75 秒内没有心跳且没有连接 → 自动转「离线」，其他人看到「x 小时前在线」/「上次登录 x 小时前」。
- 可手动切换 **在线 / 忙碌 / 离开**（顶栏身份胶囊、我的资料、消息页），只是给同事的提示，不影响收消息；退出登录立刻离线。
- 可见范围：所有登录账号都能看到全部同事的状态点与最近在线时间——入口是「消息」页的同事列表，主账号与 M 岗还能在「团队管理」看到。

**私聊与传文件**

- 入口：顶栏「消息」（带未读红点）→ 左栏同事列表（在线优先排序，带未读数和最后一条预览）→ 右栏对话。
- 支持文字（≤2000 字）与附件（单文件 ≤100MB，图片自动预览，其他类型给下载卡片）；支持拖拽发文件。
- 实时到达：新消息、未读数变化、在线状态都走 SSE，不需要刷新；未读数在任意页面都会实时更新。
- 页面卸载（`pagehide` / `beforeunload`）会主动关闭 SSE 与心跳。**这一步不能省**：浏览器对同一域名只有 6 条并发连接，残留的 EventSource 会占满连接池，连点几层页面后新页面就抢不到连接、整站卡住；从 bfcache 返回时会自动重连。
- 会话为**一对一私聊**，只有收发双方能读写；附件下载同样校验参与关系。
- 删除账号时会一并清理该账号的聊天记录与附件，审计页不留「已删除账号」残影。

**聊天记录（主账号审计）**

- 独立页面 `/chat-audit.html`（导航「聊天记录」，仅主账号可见）：全部会话按最近消息排序，显示双方、条数、文件数、未读标记与预览。
- 点开可看完整对话（含附件与「未读」标记），支持**导出为纯文本**留痕；接口层面对子账号一律 403。

### 界面与 IP 形象

主题为**鲸鱼女仆 · 奶油蓝**：底色奶白 → 淡蓝渐变，主色皇家蓝 `#2f6be0`，金色 `#f6c445` 只做星光点缀；卡片 22px 圆角、白色玻璃顶栏、胶囊导航（当前页蓝色高亮），身份与「退出」独立成组；移动端（≤860px）自动折成两行：logo + 账号一行、导航可横向滑动。

- **首页**：双栏 Hero（左侧 IP 头像胶囊 + 问候语 / CTA / 能力标签，右侧 IP 相框 + 蕾丝虚线圈 + 金色星光 + 浮动小标签）→ 五格统计条（每格带线性小图标；项目数 / 今日新建 / 今日素材 / 今日视频 / 进行中任务，后两项可点进聚合页）→ 最近项目卡。
- **登录页**：左侧 IP 相框（虚线蕾丝圈 + 星光 + slogan + 能力标签）/ 右侧表单的分栏卡片；页面背景为奶白→蓝渐变，漂浮气泡与金星，移动端自动堆叠。
- **空状态 / 上传区**：用 IP 头像（圆形）做浅色装饰。
- **导航**：全站统一为 首页 / 今日数据 / 设置（+ 团队管理：主账号与 M 岗可见；管理权限：仅主账号可见）；右上角身份胶囊带头像、昵称、职级徽章与角色，点击进入「我的资料」。

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `public/img/ip/maid.webp` | 640×640 | 首页 Hero 相框、登录页相框 |
| `public/img/ip/maid-head.webp` | 480×480 | 顶栏 logo、favicon、Hero 胶囊头像、空状态、上传区 |

形象来自用户提供的 IP 插画（WebP 压缩，640px 控制在 ~70KB）；替换形象时直接覆盖同名文件即可（正方形）。配色取自插画：主色 `#2f6be0`、奶白 `#fdfaf3`、浅蓝 `#7fb4f0`、金色点缀 `#f6c445`。

## 六、环境变量（`.env`，可选）
复制 `.env.example` 为 `.env`。默认即可运行：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 服务端口 |
| `FFMPEG_PATH` | `bin/ffmpeg.exe` | FFmpeg 路径（相对项目根或绝对） |
| `FFPROBE_PATH` | `bin/ffprobe.exe` | ffprobe 路径 |
| `DATA_DIR` | `data` | 数据目录 |
| `GENERATE_DEMO_MUSIC` | true | 未上传音乐时是否生成系统示例背景音乐 |

> 未配置密钥也能完整运行；AI 视觉模型为可选（第二阶段）。

## 七、FFmpeg 依赖说明

项目已内嵌 `bin/ffmpeg.exe`、`bin/ffprobe.exe` 及所需 DLL（来自系统稳定版 4.4.3），开箱即用。

如需替换为你自己的版本，把 `ffmpeg.exe`/`ffprobe.exe`（及 DLL，如为共享库构建）放入 `bin/`，或在 `.env` 指定绝对路径。验证：

```bash
bin/ffmpeg.exe -version
bin/ffprobe.exe -version
```

必须包含滤镜：`scale crop concat amix fade blackdetect silencedetect edgedetect drawtext`；编码器：`libx264 aac`。

## 八、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（FFmpeg 就绪状态，无需登录） |
| POST | `/api/auth/login` | 登录（账号+密码），成功后下发会话 Cookie |
| POST | `/api/auth/logout` | 退出登录 |
| GET | `/api/auth/me` | 当前登录用户（含职级、头像、可分配职级） |
| POST | `/api/auth/password` | 修改自己的密码 |
| PATCH | `/api/auth/profile` | 本人改昵称 / 手机号 / 签名（用户名与登录账号不可改） |
| POST/DELETE | `/api/auth/avatar` | 上传（自动裁 240×240 WebP）/ 删除自己的头像 |
| GET | `/api/users/:uid/avatar` | 读取成员头像（登录后可见） |
| GET | `/api/team/overview` | **主账号 + M1-M4 管理岗**：全部成员今日统计与职级 |
| GET | `/api/team/levels` | 职级目录（professional P0-P8 / management M1-M4）+ 我的可分配范围 |
| PATCH | `/api/team/users/:uid/level` | 调职级：传 `level`（P0-P8）或 `manageLevel`（M1-M4，传空取消），**主账号可调任何人含自己，管理岗只能调不高于自己的同通道职级** |
| GET | `/api/presence` | 全部账号的在线状态（在线/忙碌/离开、最近在线） |
| POST | `/api/presence/ping` | 心跳，维持在线 |
| POST | `/api/presence/status` | 切换自己的在线模式（online/busy/away） |
| GET | `/api/chat/stream` | SSE：在线快照、新消息、已读、未读数 |
| GET | `/api/chat/users` | 同事列表（状态 + 未读 + 最后一条消息） |
| GET/POST | `/api/chat/messages` | 拉取与某人的记录 / 发文字（`to` + `text`） |
| POST | `/api/chat/upload` | 发附件（multipart：`file` / `to` / 可选 `text`，≤100MB） |
| POST | `/api/chat/read` | 标记与某人的会话已读（清零未读数，写入 `readAt`） |
| GET | `/api/chat/files/:fid` | 下载/预览附件（收发双方 + 主账号） |
| GET | `/api/chat/audit` | **仅主账号**：全部会话总览与统计 |
| GET | `/api/chat/audit/messages` | **仅主账号**：任意两人的完整记录 |
| GET | `/api/chat/audit/export` | **仅主账号**：导出某段会话为 txt |
| GET | `/api/team/permissions` | **仅主账号**：成员权限总览（含每个人今日视频数与 `viewAllVideos`） |
| POST | `/api/team/users` | **仅主账号**：创建运营子账号 |
| PATCH/DELETE | `/api/team/users/:uid` | **仅主账号**：改密码/停用/授权（`permissions.viewAllVideos`）/删除（删除时项目转给主账号） |
| GET/POST | `/api/projects` | 项目列表 / 创建（子账号自动只含本人项目；主账号可加 `?user=<uid>`） |
| GET/DELETE | `/api/projects/:id` | 项目详情 / 删除（越权返回 403） |
| PATCH | `/api/projects/:id` | 改成片模板 `style` / 时长 / 数量 / 品牌片尾 `brand` / 字幕开关 `subtitle` |
| GET | `/api/project-templates` | 成片模板目录（新建页与项目页的下拉都用它） |
| POST | `/api/projects/:id/upload/init` | 分片上传初始化 |
| POST | `/api/projects/:id/upload/chunk` | 上传分片 |
| POST | `/api/projects/:id/upload/finish` | 合并并触发分析 |
| PATCH | `/api/projects/:id/materials/:mid` | 改分类 / 必用 / 禁用 / 确认 |
| POST | `/api/projects/:id/materials/:mid/reanalyze` | 重新分析 |
| POST/DELETE | `/api/projects/:id/music` | 上传 / 移除背景音乐 |
| POST | `/api/projects/:id/render` | 开始渲染（可带 `single`+`videoId`+`overrides`） |
| GET | `/api/projects/:id/stream` | 项目 SSE 进度 |
| GET | `/api/tasks/:taskId/stream` | 任务 SSE 进度 |
| PATCH/DELETE | `/api/projects/:id/videos/:vid` | 重命名 / 锁定 / 删除 |
| GET | `/api/projects/:id/videos/:vid/file` | 下载单条视频 |
| GET | `/api/projects/:id/videos/zip` | ZIP 批量下载 |
| GET | `/api/stats` `/api/today/videos` `/api/today/tasks` | 首页/聚合统计（子账号默认只统计本人；被授权「看全部视频」的运营在 `/api/today/videos` 可见全部成员；主账号可加 `?user=`） |
| GET | `/api/today/videos/zip` | 今日视频打包下载 |
| GET/POST | `/api/settings` | 默认剪辑参数：读（所有人）/ 写（**仅主账号**）。设置页已下线，接口保留备用 |
| GET | `/api/library` | 跨项目素材库（按权限过滤） |

## 九、测试结果（本地实测）

测试素材：合成的 5 段正常视频（8/6/10/5/5s）、1 张图片、1 段黑屏、1 段无音频，共 7 个。

- 上传：7 个素材分片上传成功。
- 分析：7 个全部完成；`black.mp4` 正确标记「含黑屏片段 / 画面可能模糊」并判为不可用；其余可用；全部标记「需确认」。
- 混剪：生成 3 个版本 A/B/C，均 **28.6s / 1080×1920 / H.264+AAC / yuv420p**，单条约 1.3MB。
- 预览/下载：单条下载、ZIP 批量下载（约 3.6MB）均成功。
- 字幕：抽帧验证中文标题与卖点字幕正确渲染，且随时序切换（"栗子打包盒"→"支持定制"）。
- 编辑重生成：改标题+静音+按 `videoId` 替换，原视频被替换、锁定状态保留、数量不增加。
- 页面：首页/创建/工作台/设置/样式/脚本均 200。

复跑：`node test/e2e.js`（需服务已启动）。

### 账号与权限测试

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `node test/auth.js` | 登录/未登录拦截、子账号创建、数据隔离、越权 403、停用即时生效、重置密码、删除转移项目、退出 | **37 项全通过** |
| `node test/permissions.js` | 管理权限页接口、子账号默认仅自己、按人授权「可看全部视频」、授权后可播可下但不可进他人项目、收回即时生效、重新登录仍有效、主账号权限不可改 | **46 项全通过** |
| `node test/profile-level.js` | 个人资料（改昵称/手机号/签名、用户名不可改、昵称查重）、头像上传/裁切/读取/删除、非图片拒绝、双通道职级目录（P9 + M4）、两条通道可并存（M2 兼 P7）、主账号可改自己、管理岗同通道越权拦截（专业职级与管理层各自的上下限）、非法/跨通道值 400、团队概览与权限页带两条通道 | **68 项全通过** |
| `node test/chat.js` | 在线心跳与手动状态、登录即在线、退出即离线、同事列表与未读数、私聊收发/校验、已读状态（`readAt` 与未读归零，界面不显示「已读」）、100MB 内附件上传下载与中文文件名、无关账号下载 403、SSE 首帧与实时推送、主账号审计与导出、子账号审计 403、删除账号连带清理会话 | **54 项全通过** |
| `node test/ui-auth.js` | 登录页、错误密码提示、导航身份标识、团队页创建账号、管理权限页（对照表/开关锁定）、主账号按运营查看、运营视角隔离、运营访问团队页与管理权限页被弹回、导航无「设置」入口、资料页改密码弹窗、全局设置接口仅主账号 | **29 项全通过**（需 Chrome `--remote-debugging-port=9333`） |
| `node test/operator-flow.js` | 运营登录 → 建项目 → 分片上传 → 分析 → 渲染 → 播放下载 → 主账号可见 | **16 项全通过**（约 40s） |

## 十、已知限制

1. **AI 内容理解**：第一阶段为启发式（黑屏/静音/运动/清晰度 + 类别规则），不能真正识别"这是哪款产品"。产品身份与"是否同款"一律标记需人工确认——这是刻意的安全设计。真实视觉识别在第二阶段接入。
2. **镜头切分**：当前以"整个素材 = 一个镜头"为主，长视频的多镜头精细切分在第二阶段增强。
3. **字幕**：短句字幕按镜头切换（一句一屏、自动均衡断行），模板默认不压顶部标题；未做逐字卡拉OK与口播语音转写（ASR 属第二阶段，目前口播字幕文案由规则生成而非跟随人声逐句对齐）。
4. **背景音乐**：无内置版权曲库；默认用系统合成的示例音乐（可替换），正式发布请使用已授权音乐。
5. **性能**：单进程串行渲染；大量并发/超长视频需接入独立渲染队列与多机。
6. **临时文件**：渲染临时文件会清理；若运行环境限制批量删除，可能残留于 `data/temp`，可手动清理。
7. **权限范围**：当前为「主账号 + 运营」两级角色，运营之间默认互相隔离；额外的细分权限目前只有「可看全部视频」一项（按人开关）。如需「只读审计员」「按产品线分权」或多团队，可在 `auth.js` 的 `permissions` 上继续扩展字段。
8. **账号安全**：会话密钥存于 `data/.session-secret`，密码 scrypt 哈希；尚未加入登录失败锁定、短信验证码、二次验证。对公网部署建议前置 HTTPS 与反向代理限流。

## 十一、成本说明

- 软件栈全部开源免费；无强制付费 API。
- 第二阶段若接入视觉/语音大模型或云存储、版权音乐，费用由对应服务商决定，接口已在 `ai.js` 预留、可替换。

## 十二、后续扩展方法

- **接入真实视觉模型**：实现 `server/lib/ai.js` 的 `analyzeVisual()`，返回 `{category, confidence, productConfirm, tags}`；在 `analysis.js` 中优先调用，失败再回退启发式。
- **语音转写/旁白**：新增 ASR 接口，把结果作为字幕或 TTS 音轨，在 `render.js` 合成阶段 `amix` 进去。
- **精细镜头切分**：用 `ffmpeg.sceneCuts()` 把长素材拆成 `segments`，editor 按片段排片。
- **模板/批量**：把 `editor.js` 的 `VARIANTS` 做成可配置模板；新增"批量多项目"任务即可。
- **部署**：生产建议 `pm2`/系统服务守护 + Nginx 反代 + 独立数据盘；渲染可拆成独立 worker（共享 `data/` 与任务表）。

---

### 快速体验

1. `npm install && npm start`
2. 打开 http://localhost:3000 → 新建项目（如"栗子打包盒 / 包装盒 / 抖音 / 9:16 / 30s / 3条 / 产品实拍展示"）
3. 拖入素材 → 等待分析 → 「开始混剪」→ 在「视频结果」预览/下载/打包
4. 「视频编辑」可改标题、调整镜头顺序、改卖点字幕、换音乐后**重新生成单条**
