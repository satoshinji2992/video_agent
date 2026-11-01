# video agent 架构

虚线框表示规划中、尚未实现的部分。

```mermaid
flowchart TB
  U["用户消息"] --> Q["会话管理<br/>排队 · 停止 · / 命令转义"]
  Q --> O["开场回复<br/>与主 Agent 并行，先到先用"]
  O -->|开场句| CHAT["对话区"]
  Q --> A

  subgraph AGENT["主 Agent · Claude Agent SDK · Opus 5.5"]
    direction TB
    CTX["上下文<br/>系统提示词 · 记忆前 15 条 · 已启用技能"] --> A["Agent 循环<br/>思考 → 调用工具 → 观察结果"]
    A --> H["Hooks<br/>技能白名单 · 只读技能目录 · 写轨迹"]
  end

  H --> TOOLS
  subgraph TOOLS["工具"]
    direction LR
    P["save_plan<br/>分镜 · 画幅 · 风格"]
    R["render_code_shot<br/>动画镜头"]
    S["generate_seedance_shot<br/>写实镜头"]
    M["assemble_video<br/>合成 · 字幕 · BGM"]
    K["Skill / Read<br/>技能资料"]
  end

  R --> CH["Chrome + FFmpeg 渲染"]
  S --> SD["Seedance（后台任务）"]
  M --> CHK["抽帧自检<br/>图片回传给模型"]
  CHK --> A
  S -.预算检查.-> L["花费账本 · 上限 $100"]
  A --> F["旁白过滤<br/>后面紧跟工具调用的文字不显示"]
  F -->|成片说明| CHAT
  A -->|返工确认| AP["确认卡片"]

  A -->|本轮结束| BG
  subgraph BG["后台"]
    direction LR
    RV["自动点评<br/>四项评分"]
    MEM["记忆整理<br/>偏好与审美"]
    TR["轨迹记录"]
  end
  MEM -.下次新对话.-> CTX

  HB["心跳调度器<br/>任务恢复 · 定时任务"]:::plan -.-> A
  classDef plan stroke-dasharray: 5 5
```

## 说明

- **开场与主循环分开**：开场句由一次快速调用生成，与主 Agent 并行，哪边先写出来就用哪边；主 Agent 按正常思考深度规划分镜、调用工具。
- **上下文**：系统提示词规定说话方式和视频制作规则，另外附带自动整理的用户偏好（记忆）和已启用的技能。
- **工具**：4 个视频工具，加上只读的技能工具。命令执行等内置工具全部关闭，所有调用都经过 Hooks 检查并写入轨迹。
- **质量闭环**：合成后抽帧交给模型自检；每轮结束后在后台自动评分，并把用户反馈整理进记忆，供后续新对话参考。
- **规划中**：心跳调度器，负责服务重启后恢复任务、执行定时任务，以及后台任务完成后主动跟进。
