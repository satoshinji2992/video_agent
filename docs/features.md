# 功能与实现细节

这里记录 agent 各项能力的具体做法和接口。总体架构见 [agent-architecture.md](agent-architecture.md)，数据文件见 [data.md](data.md)。

## 技能

技能是一个带 `SKILL.md` 的文件夹，里面是镜头配方、节奏、缓动参数、设计规则这类现成经验，agent 需要时会加载。

- **安装**：管理员在服务器上执行 `npm run skill:add <git 仓库地址>`。脚本会把仓库浅克隆到 `skills/<名字>`，去掉 `.git` 和 `.github`，校验 `SKILL.md` 的 frontmatter，并把来源地址和 commit 记到 `data/skills.json`。`SKILL.md` 里有加载时执行的命令（`` !` ``）会被拒绝安装。网页上不开放安装。
- **启用**：在系统面板的「技能」页用开关控制。启用的技能会链接进每个对话的 `.claude/skills`，用 `settingSources: ['project']` 加载；不加载 `user`，开发机上个人的技能不会带进来。
- **使用**：agent 自己判断要不要用技能。用户也可以点输入框旁的 ✦ 指定技能，发送时会显式调用。用户自己输入的以 `/` 开头的消息会被转义，不会被当成命令执行。
- **权限**：agent 只多了 Skill、Read、Glob、Grep 四个工具。PreToolUse hook 只允许读技能目录里的文件，只允许调用已启用的技能，其他路径一律拒绝；hook 先于任何 allow 规则执行。
- **示例**：[video-shotcraft](https://github.com/Vincentwei1021/video-shotcraft)。它原本基于 Remotion，这里不运行 Remotion 和 Python，只借用它的镜头卡和 demo 里的运动逻辑，移植成 HTML 动画；它自带的 BGM 可以在合成时作为背景音乐。

## 对话流程

- **何时提问**：一条判断标准（`ASK_RULE`，src/agent/prompt.ts，系统提示词和开场模型共用）：推断不出、猜错就白做的信息才问，一次只问最关键的一个；其余按最合理的理解直接做，开工那句话里说出理解。
- **查资料**：讲解、行业、科技、陌生品牌类题材在写剧本前调用 `research`（中转站的 Gemini + Google Search，失败时退回 GPT + web search），每轮最多两次，费用标"查资料"。剧本中的数字和案例只能来自查到的来源。
- **剧本按需**：需求清楚就直接做；用户要看剧本、或片子长且复杂而用户没说"直接做"时才出剧本卡等确认（说了"直接做"可以出卡但不停）。
- **逐步交互**：每一步都短。人物或产品会出现在多个写实镜头时先出定妆图并用快选项确认（作为 `reference_assets`，不当所有镜头的首帧；参考图被拒时自动退回纯文字生成）。写实镜头提交后回合就结束，后台生成；每好一个，对话里出现带预览的消息（按镜头内容命名），全部到齐或有失败时系统唤醒模型（系统回合，不跑开场模型）去合成；回合进行中到达的结果在回合结束后再判断。用户点停止后，后台结果只显示、不再唤醒。
- **后台任务持久化**：写实镜头提交即写入 `data/jobs.json`（taskId、参数、是否已计费）；重启或 kill -9 后按 taskId 续查，不重复提交、不重复计费；下载失败或超时保留任务，由 10 秒心跳重试，直到结果链接过期（24 小时）。启动时被删除对话的任务按估算入账后关闭。被重启打断的回合在 30 分钟内自动接着做。
- **离开期间**：没人打开对话时发生的结果，回来时显示一张汇总卡（状态和最新一个结果）。
- **出片自检**：合成前确认每个带口播的镜头都有配音进了混音；剧本有口播而计划漏写时，save_plan 按 segment（或首个计划按顺序）自动补上。合成后测响度（有口播却低于 -40 LUFS 不交付），用 whisper 逐段听写配音（指定语言），对照口播查漏读、错读和缩写被逐字母念（`vo_tts` 写读法，字幕仍用 `vo`），超过 0.5 秒的黑屏只报告。有问题时第一次不交付、交回模型修，同一回合第二次照常交付并注明。合成结果里列出自检确认的事实，介绍只能说这些。成片按测得响度用固定增益统一到约 -16 LUFS。档案素材镜头里的坏帧（整屏同一种饱和色，src/media/framecheck.ts）和没裁掉的黑边也算自检问题；纯色标题卡只提示。
- **镜头检查**：`render_code_shot` 测静止占比（src/media/stillness.ts，静止超过一半或连续定住 2.5 秒以上就提示模型加持续运动；另测整帧变化，大部分时间整帧几乎不变也提示），合成后整片超过 60% 不动退回一次；开场第一个镜头测亮度（亮的部分不到 5% 且平均亮度低于 45 时提示提亮、放大主体）。3D 镜头报告三角形数、网格数和纯色网格数（页面挂 `window.__three`），主体太简单时提示用现成模型或细节工具。
- **3D**：3D 镜头以 2 倍像素渲染再缩小（第 1–4 帧平均超过 170 ms 时自动改回 1 倍）。`find_model` 搜 Poly Haven（CC0，请求带 User-Agent `video_agent`，署名"模型：Poly Haven"）、NASA 3D Resources、NASA SVS 的 glTF 模型；`use_model` 下载（≤150 MB），在工作线程里用 gltf-transform + meshoptimizer 减面（默认 ≤15 万三角形）、贴图经 ffmpeg 缩到 ≤2048、居中缩放成一个 .glb（src/render/models.ts，按资产 id 和分辨率跨会话缓存在 `data/model-cache/`），记入 `assets_manifest.json`，返回四个方向的预览。用了模型的 3D 镜头角标标"三维示意"（实测形状模型标来源），片尾署名列出。页面用 GLTFLoader/DRACOLoader/meshopt 解码器（vendor/three，0.186.1）从 `/assets/` 加载；程序化主体用 `vendor/kit3d/`（表面位移与法线、倒角、接缝、螺栓、线缆、材质预设、影棚环境）。
- **剪辑**：有背景音乐时按节拍检测（src/media/beats.ts）把切点对到拍点上（每个镜头最多伸缩 0.35 秒，切点落在帧格上）；用户素材的现场声默认保留（src/media/ambience.ts 判断是环境声、人声还是太吵），口播时压低、口播之间抬起来，太响的按响度再压；用户素材先统一曝光和白平衡（src/media/colormatch.ts）再上调色预设；标了手抖的片段自动防抖（src/media/stabilize.ts，只在抖动明显降低时采用）；字幕不重复画面上已经写着的字（渲染时取可见文字）。
- **语言与介绍**：用户看到的文字与用户语言不一致时先不显示，回合结束后让模型用用户的语言重说一次；出了新版本却没介绍（用户语言、至少 30 字）时，回合结束后让模型补一段介绍。两者每回合最多一次，用户已经发了新消息时不做。
- **剧本卡与问题卡**：`present_script` 以卡片展示剧本（时间、角色、画面、口播、字幕、镜头类型、insight、来源），从第 2 版起高亮改动段；`ask_user` 以 A/B/C 卡片提问，点击即作为用户消息发送，工具立即返回、本轮结束。聊天文字仍为一两句口语，不列表、不列选项；问题卡之后模型再写的文字不显示（记入轨迹）。
- **出片**：确认后按剧本段生成分镜，镜头带段 id 与口播。口播用 speech-2.8-hd 按剧本段整段合成后切回每句，按口播时长自动拉长镜头，合成时铺口播轨，背景音乐在口播处自动压低、口播之间抬起；字幕默认取口播。写实镜头可按镜头开启同步声音，合成时保留原声；这类镜头合成时用 whisper-1 听写实际台词（以生成提示词里引号内的台词作提示，结果缓存在 `clips/<hash>.speech.json`），底部按说话时间逐句出字幕，镜头的 caption 改到画面顶部。中文长字幕按词边界折成两行。成片后以建议卡给出下一步。
- **真实素材**：`find_footage` 搜 NASA Image and Video Library 和 Wikimedia Commons（src/media/footage.ts），只返回可合法再用的：NASA 自有素材（公司、合作航天机构、大学版权的剔除；ESA/Hubble 按 CC BY 4.0 标注），Commons 只收公有领域、CC0、CC BY、CC BY-SA，剔除 NC/ND/非自由和来源存疑的截图。结果用短编号（f1、f2…）和一张缩略图表交给模型；`use_footage` 下载（图片 ≤15 MB，视频 ≤80 MB，转 H.264、最长 60 秒，报告开头黑场），记入 `assets_manifest.json`（来源、许可、署名、用在哪些镜头）。图片做 image 镜头，视频做新的 `footage` 镜头（`render_footage_shot`，从 `from` 秒起剪，丢掉原声；片源自带的黑边自动裁掉，基本不动的片段自动加缓推）。艺术想象图、示意图和模拟动画从元数据里识别出来，署名写成"艺术想象图（NASA/JPL-Caltech）"这类，旧工程合成时补识别。取素材和 `preview_footage` 会报告黑边、坏帧和纯色字卡的时间段。`save_plan` 的 `source_labels`（用了真实素材时默认开）在每个镜头右上角标来源（机构名 / "AI 生成画面" / "示意动画"）；用了真实素材的版本自动加 4 秒"画面来源"署名卡（CC BY/BY-SA 带许可）。`save_release_notes` 生成发布文案（标题、简介、标签、署名）供下载。
- **出图参考**：`generate_image` 的 `reference_images` 可传 assets/ 里的图或 `shot:<镜头id>`（取该镜头一帧），gpt-image-2 走 `/v1/images/edits`，Seedream 以 data URL 传 `image`，用于让海报、封面里的人物和产品与片中一致。
- **能力更新提示**：`CAPABILITY_UPDATES`（src/agent/prompt.ts）每次能力变化追加一条；升级前开始的对话在下一条消息前收到一次说明，避免沿用以前"做不到"的说法。
- **模型**：系统面板"模型"页设置默认对话模型、思考强度、写实镜头模型、配音开关与音色、同步声音默认值（存 `data/settings.json`）；对话顶栏可单独切换该对话的模型（存 meta.json），下一轮生效。
- **探测脚本**（需要中转站，在 dev 环境运行）：`scripts/tools/probe-voice.ts`、`scripts/tools/probe-research.ts`。

## 上传用户素材

用户的视频、照片、音频和文档（PDF、txt/md/csv）走分片上传，入库后供 agent 剪辑。图片 ≤8 MB 仍可随消息内联（base64）发送。

**接口**（`:id` 为对话 id，返回均为 JSON）：

1. `POST /api/sessions/:id/uploads`，body `{ "name": "店/视频/IMG_0001.MOV", "size": 12345678, "batch": "b1" }` → `200 { "id": "<uploadId>", "chunkBytes": 4194304 }`；超出限制返回 `429 { "error": "…" }`。`name` 只用于显示（可含文件夹路径），磁盘文件名由服务器生成；`batch` 把同一次选择的文件归到一张进度卡。
2. `PUT /api/sessions/:id/uploads/:uploadId?offset=<已收字节>`，body 为原始字节（≤ chunkBytes）→ `200 { "received": n }`。offset 必须等于已收字节数（重发最后一块且内容相同会被忽略），否则 `409 { "error": "…" }`。
3. `POST /api/sessions/:id/uploads/:uploadId/complete` → `200 { "status": "complete" | "rejected", "kind": "video|audio|image|pdf|text", "mediaId": "m3", "error"?: "…" }`。服务器按文件头判断类型并用 ffprobe/pdfinfo 校验；通过的进入后台入库。
4. `DELETE /api/sessions/:id/uploads/:uploadId` 取消。
5. `GET /api/sessions/:id/media` → `{ "items": [MediaItem…] }`（不含文档全文）。
6. 发消息时 `POST /api/sessions/:id/messages` 可带 `"media": ["m1","m2"]`，消息里会注明这些素材及是否已入库。

**限制**（`UPLOAD_*` 环境变量可改）：单文件 500 MB、单对话 3 GB / 200 个文件、全部对话 60 GB、磁盘剩余不足 20 GB 拒绝、同一 IP 同时 2 个上传、每小时 5 GB；视频长边 ≤4096、≤15 分钟、≤120 fps，每条画面轨都检查；PDF ≤30 页；文本 ≤1 MB UTF-8。HEIC/AVIF 暂不支持。

**入库**（src/media/ingest.ts，后台，最多 2 个并行，重启后续做）：探测（旋转、10-bit、HDR）、H.264 8-bit 720p 代理（预览和剪辑都用它，原片保留）、场景切分、每段 3 张关键帧和总览图、画质检查（过曝、太暗、模糊、手抖、黑场、太短）、跨素材重复检测（`重复` 不可用，`相似` 仅提示）、有人声的听写（whisper）、PDF/文本读取（pdftotext，30 页、15 秒超时）。之后 Claude 看关键帧写每段描述、标签，并标出误拍（src/media/describe.ts，同时最多 2 个）。一批文件全部处理完后，系统唤醒模型，先告诉用户看到了什么。对话里每批上传一张进度卡，逐个文件显示上传进度和处理阶段。

**剪辑**：`list_media` 看每段描述、标签和问题，`inspect_media` 看任意时刻的帧，`read_document` 读文档；`clip` 镜头（media、in、speed、reverse、reframe、grade、keep_audio）用 `render_clip_shot` 从代理文件剪出；照片做 image 镜头时 `image` 直接填素材编号。用户自己的素材不加来源角标。

**注意**：所有 query() 都显式传 Claude Code 可执行文件路径（`claudeExecutable`，src/providers/llm.ts）。不传时 SDK 每次都会同步调用 `process.report.getReport()` 判断 libc，在网卡枚举慢的机器（如 WSL）上会把整个服务卡住约 10 秒。服务器日志里的 `event loop stalled N ms` 用来发现这类问题。

## 响应速度

- **开场回复**：每轮的第一句话（"我先按……做一版，几分钟就好"）由一次单独的短调用与 agent 并行生成（同一模型，低 effort，相同的系统提示词和记忆，不带工具）。两者谁先写出开场就显示谁的：短调用先到时，agent 自己的开场句（其后紧跟工具调用）按工作旁白处理，不显示；agent 先开口时，短调用的结果丢弃。因此后台点评等负载拖慢短调用时，首句也不会晚于 agent 自身。提问、闲聊等不需要开工的消息，短调用返回 PASS，由 agent 回答。可用 `FAST_FIRST_REPLY=false` 关闭。原因：effort 和思考开关在 CLI 中按整轮生效，无法只对第一次请求降低。
- **逐镜头制作**：分镜保存后逐个编写并渲染镜头，不先构思全部镜头，保存分镜后的空档一般在 30 秒以内。
- **工作旁白**：两次工具调用之间写给用户的短句（如"主角定好了，开始拍"）照常显示；自言自语（"我先调用……"、Let me…）、和用户语言不一致的、重复开场的，只记入轨迹（`kind:"narration"`）。

## 轨迹、点评和记忆

- **轨迹**：每个对话的 `trajectory.jsonl` 记录用户消息、阶段、每次工具调用（参数、结果、耗时、失败和被拒绝的调用）、回合花费和产出的版本。对话顶部的「轨迹」按钮按回合展示时间线，也能下载原始文件。花费只在这里和系统面板出现，不进对话。
- **自动点评**：每个回合结束后，后台调用一次 `REVIEW_MODEL`（默认同主模型），按响应速度、对话自然度、需求遵循、成片质量（看最后一版的抽帧）各打 1–5 分，加 2–3 句具体问题。结果写进轨迹（`kind:"review"`）和 `data/reviews.jsonl`；花费记入账本，标「点评」。后台任务一次只跑一个，单次最长 3 分钟。系统面板「轨迹」页可以关掉，也能按分数排序，并导出全部轨迹、点评、记忆和账本（`/api/export`，tar.gz）。
- **人工评价**：成片卡上的 👍/👎 和附言写进轨迹（`kind:"feedback"`），并用来更新记忆。
- **记忆**：`data/memory.json` 存用户的偏好和审美（审美、节奏、文案语气、平台、禁忌；不存店名、价格这类具体项目的事实），每条带依据（对话和原话）、置信度和来源。每个回合结束、以及有人点 👍/👎 时在后台整理：只记有证据的，相同的合并并提高置信度，冲突的改写；手动写的条目不会被自动改写或删除。新对话开始时，置信度最高的 15 条会加进系统提示词，用户当轮明确的要求优先。系统面板「记忆」页可以查看、编辑、删除、手动添加，或关掉自动更新。没有登录，所有访问者共用一份记忆。

## 预算

全局花费账本记在 `data/ledger.jsonl`，服务重启后会接着累计。

- **计入哪些**：真实调用的 Seedance；配置了端点或 key 的 Claude。本机订阅和占位片段不计。
- **怎么计**：优先用接口返回的用量；没有返回时按单价表估算，并标注为估算。
- **上限**：默认总上限 100 美元，到 80% 时提醒一次。超出上限的调用会被拒绝，agent 会在对话里告诉用户。
- **网页显示**：金额不出现在对话里。侧栏底部「系统」入口有状态圆点：绿色表示正常，黄色表示用量超过 80% 或写实镜头处于示意画面模式，红色表示额度用完。系统面板的「用量」页有总额、按对话的花费和明细。达到 80% 时只弹一次右上角提示。
- **币种**：服务商按人民币扣费的，用 `USD_CNY_RATE` 换算成美元记账，标为「实际」；按单价表算的标为「估算」。

## 联网查资料和网络图片

- **查资料**（`research`，src/providers/research.ts）：优先用 Tavily 搜索（advanced）。排名靠前的结果摘要太短时，再用 Tavily extract 读原文，截取和查询相关的一段。交给模型的是逐条原文摘录，每条带原始链接、站点和发布日期（有的话），剧本卡的来源直接用这些链接。可以限定站点（`domains`，比如只查 nasa.gov）和时间范围（`time_range`）。Tavily 没配置或失败时，退回中转站的 Gemini（Google 搜索）和 GPT（web search），由它们写要点。每次调用按 Tavily 返回的 credits 记账（`TAVILY_USD_PER_CREDIT`），额度用完就拒绝。
- **找图**（`find_web_image`）：给了 App 或品牌名时，先查 App Store 的公开接口（itunes.apple.com/search，不用密钥），拿 512 像素图标；再用 Tavily 搜图，候选带图片描述。候选编号为 w1、w2…，缩略图拼成一张图给模型看，另外列出相关页面。
- **取图**（`use_web_image`，src/media/webimage.ts）：接受候选编号，或者任何 https 图片 / 网页地址。网页会从 logo 图片、apple-touch-icon、图标、og:image 和页面主图里挑（最多 4 张）。网页的 HTML 里取不到时，用无头 Chrome 打开页面兜底（src/render/webpage.ts）：页面上实际显示的图片重新下载；下载不了的，或者 inline SVG 形式的 logo（链接到首页、带 logo 字样、在页头），就对元素截图。
- **安全**：所有请求只接受 https 和默认端口，不能带账号密码。主机名解析出来的每个地址都必须是公网地址：本机、内网、链路本地、CGNAT、云厂商元数据（169.254.169.254、100.100.100.200）、组播和保留地址一律拒绝。直连时连接固定在检查过的那个地址上，防止 DNS 被换成别的答案。重定向手动逐跳检查，最多 5 次。网页上限 2 MB，图片上限 10 MB。按文件头判断格式，并要和 content-type 一致。位图解码后重新编码成 PNG，长边最多 2048。SVG 只有在不含脚本和外部引用时才保留。浏览器兜底时，页面发出的每个请求都走同样的地址检查，service worker、WebSocket、音视频和下载都关掉。
- **来源**：取到的图记进 `assets_manifest.json`：`source: "web"`、页面地址、图片地址、获取时间，署名为"网络图片（站点）"。用在图片镜头里时，和图库素材一样带来源角标，片尾也会列出。
- **图库**（NASA、Wikimedia Commons、Poly Haven 等）：统一使用 User-Agent `video_agent/<版本> (+https://github.com/satoshinji2992/video_agent)`。遇到 403、429、5xx 时，隔 1 秒、3 秒各重试一次；有 Retry-After 就按它来，最多等 10 秒。还是失败时，报出是哪个库、什么状态、对方给的原因，并提示可以换库、稍后再试或者在网上找图（src/core/http.ts）。

