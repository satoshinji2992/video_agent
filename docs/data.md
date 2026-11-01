# 数据目录 data/

服务端把运行时数据都写在 `DATA_DIR` 下，默认是工作目录里的 `data/`。整个目录不进 git。备份时直接拷贝整个目录即可，各文件都是普通的 JSON、JSONL 和媒体文件。

所有文件在第一次用到时自动创建，缺失或为空都能正常启动。新版本只会新增字段，不会改变已有字段的含义，所以已有数据不需要手动迁移。

## 总览

| 路径 | 格式 | 谁写 | 谁读 | 清理 |
|---|---|---|---|---|
| `sessions/<id>/` | 目录，一个对话一个 | 会话（`src/agent/agent.ts`）、工具（`src/tools/`） | 服务端、前端 `/files/` | 用户删除对话 → 进入 `trash/` |
| `trash/<id>/` | 已删除的对话目录 | `src/server.ts` | 系统面板 → 回收站 | 超过 `TRASH_DAYS` 天（默认 7）自动删除 |
| `jobs.json` | JSON | `src/core/jobs.ts` | Seedance 后台任务 | 已结束且超过 7 天的任务记录自动丢弃 |
| `ledger.jsonl` | JSONL，只追加 | `src/core/ledger.ts` | 额度判断、系统面板 → 用量 | 不自动清理（见下文） |
| `ledger-state.json` | JSON | `src/core/ledger.ts` | 同上 | 随 `ledger.jsonl` 一起清 |
| `memory.json` | JSON | `src/agent/memory.ts`、系统面板 | 每轮对话的系统提示词 | 最多 100 条，超出时先淘汰自动记下的、把握最低的条目 |
| `reviews.jsonl` | JSONL，只追加 | `src/agent/review.ts` | 系统面板 → 评审 | 不自动清理 |
| `settings.json` | JSON | 系统面板（`src/core/settings.ts`） | 服务端 | 删除即恢复默认设置 |
| `skills.json` | JSON | `scripts/tools/skill-add.ts`、系统面板 | `src/core/skills.ts` | 跟随 `skills/` 目录 |
| `model-cache/` | 目录 | `src/render/models.ts` | 同左 | 超过 `MODEL_CACHE_MAX_MB`（默认 2048）时，按最近使用时间淘汰 |

## sessions/&lt;id&gt;/：一个对话

目录名是对话的 UUID。

| 路径 | 内容 |
|---|---|
| `meta.json` | 对话元数据：`botId`、标题、是否置顶、所用模型、Claude Agent SDK 的 `sdkSessionId`、累计花费，以及 `history`（界面事件列表，打开对话时整段回放）。 |
| `project.json` | 视频项目：`title`、`aspect`、`subtitles`、`shots`（镜头列表）、`versions`（每一版成片）、`script`（剧本卡）。由 `src/media/project.ts` 的 `ProjectStore` 读写。 |
| `trajectory.jsonl` | 轨迹日志：用户消息、工具调用、工具结果、阶段变化，每行 `{ ts, kind, data }`。用于系统面板的轨迹视图和后台评审。 |
| `shots/<hash>.html` | 代码镜头的页面源码，按内容哈希命名。 |
| `clips/<hash>.mp4`、`.jpg` | 每个镜头渲染或生成出的片段及缩略图；同一个哈希可以直接复用。`<clip>.speech.json` 是语音识别缓存，`<hash>.complexity.json` 是 3D 场景复杂度统计。 |
| `versions/v<N>.mp4` | 第 N 版成片。同名前缀的 `.joined.mp4`、`.layered.mp4`、`.credits.mp4`、`.txt` 等是合成过程中的中间文件。 |
| `vo/` | 配音片段（`.mp3`），按文字、音色、模型和语速的哈希缓存；`.take.mp3` 是整段合成的原始录音。 |
| `assets/` | 镜头用到的素材：生成的图片、下载的资料片和 3D 模型（`md-*.glb`）。`assets/raw/` 是用户上传的原文件，上传过程中的分片在 `assets/raw/.part/`。 |
| `media_index.json` | 上传素材的索引：编号（`m1`…）、类型、时长、画质标记、语音转写、画面描述。由 `src/media/ingest.ts` 维护。 |
| `assets_manifest.json` | 下载素材的来源、许可和署名，生成片尾署名时使用。 |
| `.claude/skills/` | 已启用技能的链接，供 Claude Agent SDK 按项目设置加载。 |
| `.deleting` | 删除标记：对话已被删除，等后台任务结束后移入 `trash/`。 |

清理：删除对话只是先加上 `.deleting` 标记，等当前回合和后台 Seedance 任务结束后，整个目录移入 `trash/`。服务重启时，留下的标记会被继续处理。

## trash/&lt;id&gt;/：回收站

结构和 `sessions/<id>/` 相同，另有一个 `.trash.json`，记录 `{ deletedAt, title }`。系统面板可以把对话恢复回 `sessions/`。服务启动时和之后每小时检查一次，删除超过 `TRASH_DAYS` 天的条目。

## jobs.json：Seedance 任务

格式为 `{ jobs: [...] }`。每条记录 `taskId`、`session`、`shotId`、`inputHash`、生成参数、`status`（`submitted` / `succeeded` / `failed`）、是否已计费，以及时间戳。

任务一提交就写入这里，服务重启后会继续轮询，不会重复提交、也不会重复付费。已结束且超过 7 天的记录在下次写入时丢弃。

## ledger.jsonl、ledger-state.json：花费账本

`ledger.jsonl` 每行记一笔花费，格式为 `{ ts, session, item, model, usage, usd, basis }`。`basis` 是 `actual`（服务商返回的实际金额）或 `estimate`（按单价估算）。

服务启动时把所有行加起来，得到已用额度，用来和 `BUDGET_LIMIT_USD` 比较。`ledger-state.json` 只记录是否已经发出过"额度快用完"的提醒。

账本决定额度还剩多少，所以不会自动清理。要重置额度，先停止服务，把这两个文件移走或改名，再启动。

## memory.json：偏好记忆

格式为 `{ items: [{ id, category, content, evidence, confidence, updatedAt, source }] }`。这里只存用户的创作偏好（比如语气、节奏、配音），不存具体项目的事实（店名、价格、地址等）。

偏好由后台评审自动更新，也可以在系统面板里修改。最多保留 100 条，超出时先淘汰自动记下的、把握（`confidence`）最低的条目，手动添加的不会被自动淘汰。

`scripts/tools/memory-cleanup.ts` 列出看起来像项目事实的条目，加 `--apply` 会删除它们：

```sh
DATA_DIR=/path/to/data npx tsx scripts/tools/memory-cleanup.ts            # 只列出
DATA_DIR=/path/to/data npx tsx scripts/tools/memory-cleanup.ts --apply    # 删除
```

## reviews.jsonl：回合评审

每个回合结束后，后台评审写一行，格式为 `{ session, title, index, turnId, model, costUsd, ts, scores: { speed, naturalness, adherence, quality }, comments }`。只在系统面板里展示，可以随时删除或截断。

## settings.json、skills.json

`settings.json` 存系统面板里的开关（评审、记忆自动更新、默认音色、Seedance 模型等）。缺少的字段按默认值处理，旧版本的音色键会自动换成新的音色编号。

`skills.json` 存每个已安装技能的来源、提交号和启用状态。技能文件本身在 `SKILLS_DIR`（默认是 `skills/`）。

## model-cache/：3D 模型缓存

所有对话共用，同一个模型不会重复下载和优化：

- `raw/<source>/<key>/`：下载的原始模型；
- `opt/<source>/<key>/`：按面数和贴图上限优化后的 `.glb`，以及它的说明 `.json`；
- `polyhaven-models.json`：模型库目录的缓存。

每次用到缓存都会刷新文件的修改时间。服务启动时和之后每小时检查一次：总大小超过 `MODEL_CACHE_MAX_MB` 时，从最久没用的模型开始，整个文件夹删除，直到降回上限以下。一小时内用过的不删。删掉的模型下次用到时重新下载。

## 不属于 data/ 的东西

- 检查脚本（`npm run check`）每次都用一个新的临时 `DATA_DIR`，不会写进 `data/`。
- `scripts/checks/pipeline-smoke.ts` 的输出写在系统临时目录里。
- 开发集和 benchmark 素材包放在仓库外，或者在 `benchmark/packs/` 下且被 git 排除，都不在 `data/` 里。
