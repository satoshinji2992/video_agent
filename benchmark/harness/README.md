# VideoAgentBench 测试工具

对任意一个运行中的视频 Agent 实例（BASE 地址）跑 VideoAgentBench v0.2 的任务（Task 1 DART 科普、Task 2 咖啡店素材剪辑、Task 3 时间错位短片）：两阶段驱动（原始提示词 → v1，修改反馈 → v2），自动评估，双评审按用户标准打分，修改阶段三项指标，最后生成中文报告。

## 文件

| 文件 | 作用 |
|---|---|
| `vab-tasks.json` | 任务定义：原始提示词、修改反馈、隐藏关注点（来自 `../benchmark-v0.2.md`），Task 2/3 的素材包和评测答案路径 |
| `driver.mjs` | 驱动一次独立运行，扮演“配合但很懒”的用户，日志写到 `runs/<名字>.json` |
| `vab-eval.mjs` | `evidence`（自动评估 + 证据）、`judge`（六项打分）、`revise`（修改三项） |
| `vab-report.mjs` | 汇总成中文报告 |
| `lib.mjs` | 公共函数：路径、账本、抽帧、Claude/Gemini 调用 |
| `ocr.py`、`guards/run.py` | 画面文字 OCR、内容守卫（用 `VAB_PY` 指定的 Python 运行） |
| `server.sh` | 可选：用固定设置启动一个被测实例 |
| `probe.mjs` | 可选：检查两个评审模型能不能调通 |

## 依赖

- Node 22+、ffmpeg/ffprobe。用仓库根目录的依赖：在本目录 `ln -s ../../node_modules node_modules`，或单独 `npm i @anthropic-ai/sdk`。
- 素材包：先在仓库根目录运行 `benchmark/scripts/fetch-packs.sh`，Task 2、Task 3 的素材会解压到 `benchmark/packs/`。`vab-tasks.json` 里的路径相对本目录。
- 密钥只从环境变量读，脚本不打印密钥。两种用法：
  - `--env-file=<仓库>/.env`：被测实例和评审 A（Claude）都走 `.env` 里配置的 API；
  - 不含 `ANTHROPIC_*` 的 env 文件（例如 `.env.cc`，只放 Seedance、配音、出图、whisper、Gemini 用的中转配置）：被测实例和评审 A 都用本机 Claude Code 的登录。评审 A 要走 API 时设 `VAB_JUDGE_A=relay`。
- 内容守卫和 OCR 需要一个 Python 环境，里面装好 TimelineBench（Apache-2.0，https://timelinebench.vercel.app ，本工具用的是 1.0.0、提交 68a91b9）及其 OCR 依赖，运行时用 `VAB_PY=<python 路径>` 指定。没有时，守卫数值和 OCR 标为不可用，其余照常。

## 重跑一个任务

```bash
cd benchmark/harness
ENV=../../.env   # 被测实例和评审用的 API 配置

# 0. 被测实例：已有实例直接用它的地址；或者用本仓库起一个（数据放 ./data）
./server.sh start 8790      # 默认 VEVAL_APP_DIR=本仓库、--env-file=<仓库>/.env；等出现 warm-up 行

# 1. 两次独立运行（可以并行）。评估要读实例的 DATA_DIR（工程快照、轨迹、账本）。VAB_TASK 选任务：vab-t1 / vab-t2 / vab-t3
export BASE=http://127.0.0.1:8790 VEVAL_DATA_DIR=$PWD/data VAB_TASK=vab-t1
node driver.mjs $VAB_TASK $VAB_TASK-run1 > run1.log 2>&1 &
node driver.mjs $VAB_TASK $VAB_TASK-run2 > run2.log 2>&1 &
wait

# 2. 自动评估 + 证据（抽帧每 3 秒一张、whisper 转写、OCR、剧本、检索记录、对话过程）
for s in run1-v1 run1-v2 run2-v1 run2-v2; do node --env-file=$ENV vab-eval.mjs evidence $s; done

# 3. 打分（每个评审 3 次取平均；A 是 Claude，B/C 是 Gemini；C 是补充评审，可不设）
#    只重算某个评审：加 --only A（或 B），其他评审的结果保留，被替换的 A 留作 judgeA_<旧通道>
export VEVAL_EXTRA_JUDGE=gemini-3.1-pro-preview
for s in run1-v1 run1-v2 run2-v1 run2-v2; do node --env-file=$ENV vab-eval.mjs judge $s; done
node --env-file=$ENV vab-eval.mjs revise run1
node --env-file=$ENV vab-eval.mjs revise run2

# 4. 报告（开头的被测说明、“最大差距”和“方法”三部分读 notes/vab-intro.md、notes/vab-gaps.md、notes/vab-method.md，需要人工写；没有时只出表格）
node vab-report.mjs

./server.sh stop 8790
```

运行结果写在本目录的 `data/`、`runs/`、`logs/`、`vab/`、`vab-t2/`… 下，这些目录不进 git。

对照系统（黑盒）：`VAB_EXTERNAL_VIDEO=/path/x.mp4 VAB_EXTERNAL_NAME=名字 VAB_EXTERNAL_NOTES=对话转述.txt`，主体名用 `grok`（不设 `VAB_EXTERNAL_VIDEO` 时不能评这个主体）。

## 规则和口径

- 预设回复（benchmark 允许）：问题卡点推荐项（没有推荐项点第一个）；只有剧本卡时回“可以，按这个做”；机器人用文字提问时回“面向普通观众就行，时长你定，直接做吧”；一轮出错回“继续”；收费重做的确认卡点允许。全部写进 `runs/*.json` 的 `turns` 和 `decisions`。
- 停止：出现新成片并且这一轮结束即算本阶段交付（成片后自检又合成的新版本也算在本阶段内）。每阶段最多 60 分钟、6 条用户消息。所以 v1/v2 是阶段交付物，会话里的版本号可能不是 1/2。
- 评分：六项各 0–10，按 25/15/20/15/15/10 折算成 100 分；修改阶段三项各 0–10。评审回答里有空理由或缺隐藏关注点的会自动重问。
- 自动评估：时长、分辨率、fps、编码、ebur128 积分响度和真峰值、语音占比、带配音镜头数、内容守卫（静音、冻帧、重复画面、dead air、声道、人脸裁切）、全黑帧（逐帧最亮像素，严格）和 blackdetect（宽松阈值会把深色太空画面算成黑，仅供参考）。
- 已知的评审问题：gemini-3.5-flash 几乎总给满分，区分度很低，以 Claude 为主；whisper 偶尔返回英文译文（会自动重问），无人声处会编“请不吝点赞订阅”之类的句子（已过滤，原文保留在 `rawSegments`）。
