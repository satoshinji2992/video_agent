# VideoAgentBench

用来评测"对话式视频 agent"的 benchmark：用户在聊天里随口提需求，agent 做出成片；然后再提一轮修改，看 agent 改得对不对、有没有把没让改的地方改坏。

## 内容

| 路径 | 内容 |
|---|---|
| `VideoAgentBench_50_tasks.pdf` | v0.3 规格：50 个任务。 |
| `benchmark-v0.2.md` | v0.2 规格：3 个任务（DART 科普、咖啡店素材剪辑、时间错位短片）、评分细则、修改轮的评法。测试工具目前实现的就是这 3 个任务。 |
| `packs/` | v0.2 三个任务的输入素材包：`SHA256SUMS`（逐文件校验值）、`ZIPSUMS`（各任务 zip 的校验值）、`README.md`（素材说明、冻结规则、哪些文件不给 agent）。素材文件本身不在 git 里。 |
| `scripts/fetch-packs.sh` | 从 GitHub Release 下载素材包，校验后解压到 `packs/<task>/`。 |
| `scripts/pack-release.sh` | 维护者用：把素材包打成 zip，供发 Release。 |
| `harness/` | 测试工具：驱动被测 agent 跑两轮、自动评估、模型评审打分、出报告。用法见 `harness/README.md`。 |
| `tools/` | 素材包的生成工具：生成脚本和全部提示词规格，用于复现或扩充素材。 |

## 获取素材包

素材包约 400 MB（Task 1 只有文本；Task 2 约 280 MB，Task 3 约 120 MB），作为 GitHub Release 的附件分发，每个任务一个 zip。在仓库根目录运行：

```sh
benchmark/scripts/fetch-packs.sh                 # 三个任务都下载
benchmark/scripts/fetch-packs.sh task2-coffee    # 只下载一个
```

脚本会核对 zip 的校验值，解压后再逐个文件校验，结果放在 `benchmark/packs/<task>/`（这些目录不进 git）。已经存在且完好的任务会跳过。

每个任务目录里的 `evaluator/` 和 `task_metadata.json` 是评测答案和隐藏关注点，评测时要用，但不能给被测 agent 看。哪些文件可以给 agent，见 `packs/README.md`。

## 跑评测

见 `harness/README.md`。简单说：先起一个被测实例（`harness/server.sh` 可以直接用本仓库起一个），再依次运行 `driver.mjs`（两轮对话）、`vab-eval.mjs evidence / judge / revise`（评估和打分）和 `vab-report.mjs`（报告）。

评审要调用模型：评审 A 是 Claude，评审 B/C 是 Gemini。需要在 env 文件里配置对应的 API。

## 关于素材

- Task 2、Task 3 的视频、照片、菜单、Logo 和环境声全部是 AI 生成的：视频由 Seedance 生成；菜单、Logo、招牌和照片由 gpt-image-2 和 Seedream 生成；环境声取自 Seedance 生成的空场景视频的音轨。店铺资料等文本是为测试编写的。店铺（"两口咖啡"）、店主和所有人物都是虚构的，不是真实拍摄，也不对应真实的店和人。
- 素材刻意模仿手机随手拍的原始素材，其中埋了一些常见问题（具体是哪些写在 `evaluator/` 里），用来考察 agent 挑素材、修素材的能力。
- 已知限制：同一个人物在不同片段里长相不完全一致等，见 `packs/README.md`。
- v1 已冻结。要改素材，就新建一个版本，不要覆盖 v1。

## 许可

规格文档、素材包、素材说明和提示词规格采用 CC BY 4.0（见 `LICENSE`）：可以自由使用和改编，包括商用，需署名并注明改动。`harness/`、`scripts/`、`tools/scripts/` 里的代码采用 MIT（见仓库根目录 `LICENSE`）。

## 和开发的关系

这个 benchmark 只作为留出的评测集使用：在里程碑节点上跑，不用它调参。开发和调参用另外的开发集，开发集不在本仓库。
