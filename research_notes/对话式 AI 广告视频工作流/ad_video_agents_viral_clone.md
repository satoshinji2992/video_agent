# 对话式 AI 广告视频工作流：商业广告视频 Agent 与「爆款克隆 / 爆款复刻」（截至 2026-10-31）

_Research date: 2026-10-31. Labels used below: "accessed 2026-10-31" = page fetched today with no publish date shown; "search snippet" = the claim was seen only in a search-engine result or summary and the page itself was not opened or could not be fetched; "vendor" = the product's own marketing. Treat every speed and quality claim from a vendor as unverified unless an independent test is cited._

## Q1. Per-product flows: inputs, steps, user decisions, time to first video, output length, iteration model

### Takeaway
By late 2026 almost every leading product follows the same "agent plus canvas or timeline" pattern. The user supplies a brief, a product URL, product images or a reference video. The agent plans the script and the shots, sends each shot to a third-party model (most often ByteDance Seedance 2.0/2.5, also Kling, Veo, Wan, MiniMax, GPT-Image or Nano Banana), adds voiceover, music and captions, and then lets the user iterate by chat and/or per-shot editing. Products that start from a form or template (Arcads, Higgsfield Click to Ad, Mirage Ad Studio, most 复刻 apps) still need only about 2–5 explicit decisions. Ad outputs are typically 12–30 s, and rarely longer than 60 s.

### Cited Findings

#### International

**TopView (topview.ai, TOPVIEW PTE. LTD., Singapore): "AI Video Agent" + Canvas, best known for viral-video cloning**
- Current positioning (accessed 2026-10-31): "Create Any Video, Just Tell Your Agent. Describe your idea or add a script, reference video, or product URL. Topview plans scenes, selects the right models, generates assets, and keeps every shot editable on Canvas." The page lists these surfaces: Video Agent, AI Video, AI Image, Drama Studio, Canvas ("The agentic Canvas proposes scenes, creates assets, executes the production flow, and helps keep voice, characters, and visual identity consistent across multi-shot videos"), Board (multi-model asset management) and 3D Shot Composer — [TopView homepage](https://www.topview.ai/)
- Accepted inputs: "Prompt, URL, image, video, or reference mix". Dedicated flows include Reference Video Recreation, UGC-Style Ads ("lifelike AI presenters, natural hooks, creator-style pacing"), batch TikTok/Reels/Shorts, and "URL to Marketing and Ad Video" ("Paste a product URL or campaign brief") — [TopView homepage](https://www.topview.ai/)
- Example prompts in the "Video Clone" category: "remake a viral video for your product. clone the pacing of a reference video. adapt a competitor ad to your brand". Marketing examples include "make a 30-second launch video" — [TopView homepage](https://www.topview.ai/)
- Model routing shown: Seedance 2.0 for video, GPT Image 2 for images, and an "Avatar + voice" layer with "30+ language localization". A promo banner advertises Seedance 2.5, Wan 3.0, MiniMax H3, GPT Image 2.5 and an in-house "Topview T1" ("Seedance 2.5 quality at 38% of the official price"). TopView also offers MCP/Skill, Plugin and API access — [TopView homepage](https://www.topview.ai/)
- **Viral Video Agent launch (2025-11-13):** the user supplies "a product image" and "a reference video clip". The system analyzes the clip and recreates it with the product integrated, producing a "fully AI-generated, platform-ready video" "in minutes". Vendor claims include "trained on millions of viral videos" and support for A/B testing and multiple variations — [Retail Dive press release, 2025-11-13](https://www.retaildive.com/press-release/20251113-virality-becomes-a-system-topview-ai-launches-viral-video-agent-for-market)
- Third-party walkthroughs describe a 3-step user flow: choose a viral video, upload product images, let the agent customize. One YouTube digest pairs TopView with Sora 2 — [Recapio digest: TopView review](https://recapio.com/digest/this-ai-makes-viral-product-ads-automatically-topview-ai-review-by-tech-tutor); [Recapio digest: "Topview + Sora 2"](https://recapio.com/digest/how-i-make-viral-ugc-videos-using-only-ai-topview-sora-2-by-money-degree) (YouTube digests, not verified)
- Vendor testimonial: Shopnow Technology claims +80% AI-video-service revenue, −50% labor and cost, and "10× faster turnaround" — [TopView homepage](https://www.topview.ai/)

**Creatify: URL-to-video, Ad Agent / "Creatify Agent", Ad Clone**
- Creatify Agent "takes a single business URL and builds a full, high-converting ad" with hook, scenes and shot setups. The example is a 5-scene ad made "in about 60 seconds" (vendor blog, 2026-06-17) — [Creatify blog](https://creatify.ai/blog/i-turned-one-url-into-a-5-scene-converting-ad-in-60-seconds-creatify-agent)
- Cloning now runs through the Agent: "AD CLONING now goes thru via AGENT, this gives user's better handling and control… Credits consumption varies" (help article dated 2026-05-20) — [Creatify Help: Ads Clone](https://help.creatify.ai/en/articles/15049358-ads-clone)
- Plan features (accessed 2026-10-31):
  - Standard: all creation tools, 300 AI actors, "AdFlow" with 200+ templates, 1 parallel generation, videos up to 2 min.
  - Pro: adds "Ad Agent + Automations", "Competitor Ad Tracker (10M+ Meta ads)", "Ad Clone", 1,500 actors plus 3 custom avatars, videos up to 10 min, 5 parallel generations.
  - Max: 10 parallel generations.
  - Managed "Studio" service: 25–100+ videos/month with a 48-hour turnaround.
  - Source: [Creatify pricing](https://creatify.ai/pricing)
- Review caution: URL extraction can miss details, invent claims, or use wording that is not on the landing page — [Novoads Creatify review](https://novoads.ai/en/blog/creatify-review) (search snippet)

**Arcads: AI UGC actors (script → actor → talking-actor ad)**
- Reviews describe the flow as script in, choose an AI actor, get a talking-head UGC ad. Reported actor library size varies from 300+ to 1,000+ — [Fluxnote Arcads review](https://fluxnote.io/guides/arcads-ai-review); [Eesel Arcads pricing](https://eesel.ai/blog/arcads-ai-pricing) (third-party; figures conflict)
- Generation took about 7–8 min per video in an October 2026 test run by a competitor — [Predis.ai Arcads review](https://predis.ai/review/arcads/)
- One reviewer tested 24 scripts across 8 actors — [AI Funnel Insider](https://aifunnelinsider.com/arcads-ai-review-2026/) (search snippet)

**HeyGen: Video Agent (avatars)**
- **API inputs:** the endpoint is `POST /v3/video-agents`.
  - The prompt takes 1–10,000 characters, and duration is stated inside the prompt rather than as a separate parameter.
  - Up to 20 files can be attached (png, jpeg, mp4, webm, mp3, wav, pdf).
  - Optional parameters: `avatar_id`, `voice_id`, `style_id` (curated visual templates), `brand_kit_id`, and `brand_glossary_id` (custom pronunciations).
  - Orientation (landscape or portrait) is auto-detected if omitted.
  - The agent "handles scripting, avatar selection, scene composition, and rendering". Graphics are rendered with Hyperframes, "HeyGen's open-source HTML-to-video framework".
  - Source: [HeyGen API docs: Video Agent](https://developers.heygen.com/docs/video-agent)
- **Two modes:** `generate` (one-shot, "fire-and-forget") and `chat` (multi-turn; "the agent pauses for review and supports revisions") — [HeyGen API docs](https://developers.heygen.com/docs/video-agent)
- **Launch history:** unveiled with a waitlist on 2025-07-01 according to DataNorth. Product Hunt has two Video Agent launches (search snippets date them 2025-09-18 and 2026-04-10) and a separate "URL to UGC" launch — [DataNorth](https://datanorth.ai/news/heygen-unveils-video-agent); [Product Hunt (2025)](https://www.producthunt.com/p/heygen/heygen-video-agent); [Product Hunt (2026)](https://www.producthunt.com/p/heygen/heygen-video-agent-2); [Product Hunt: URL to UGC](https://www.producthunt.com/products/heygen/launches/url-to-ugc)
- A secondary guide says that in February 2026 HeyGen added Video Agent creation from inside ChatGPT plus a prompt-to-video API flow — [aividpipeline guide](https://aividpipeline.com/zh/blog/heygen-video-agent-guide-2026) (secondary; not verified)

**Pexo: chat-only "AI video agent" on top of multiple models**
- Inputs: "a URL, PDF, image, video, audio, or your idea". The flow is Plan (script, scenes, shots, creative direction), then Storyboard ("selects references, and structures the video"), then delivery of "a polished video complete with voiceover, music, motion graphics". "You can review the plan and adjust as it goes." Each step is routed to a model such as Seedance 2.0, Happy Horse 1.0, Kling 3.0, GPT-Image 2 or Nano Banana; the model pages also list Seedance 2.5, Veo 3.1 and MiniMax H3 — [Pexo homepage](https://pexo.ai/)
- Also ships as a Claude Code skill (`pexo-agent` / `video-ad`) that passes a brief to the hosted agent. The skill listing claims a typical 15-s, 3-shot product ad renders in under 8 minutes — [skillselion: Pexo video-ad skill](https://skillselion.com/skills/pexoai/pexo-skills/video-ad); [Pexo blog: Claude Code ad pipeline](https://pexo.ai/blog/how-to-build-an-ai-video-ad-pipeline-with-claude-code-from-prompt-to-published-8456)
- The homepage describes no viral-clone feature, only general use of "references" — [Pexo homepage](https://pexo.ai/)

**OpenArt**
- One-Click Story (2025) turns one sentence, a script or a song into a ~1-minute narrative video. Templates are Character Vlog, Music Video and Explainer, and the feature is also pitched for promotional ads — [CO/AI](https://getcoai.com/video/ai-video-story-just-one-click-here-is-how-openart-one-click-story/)
- "OpenArt Director" directs cinematic videos through chat (Product Hunt launch reported 2026-06-23) and targets short films, social content and brand ads — [Feedbagel](https://feedbagel.com/post/openart-director) (search snippet)

**Higgsfield: Marketing Studio / Click to Ad / Ads Studio / Ad Multiplier**
- Click to Ad: "Paste your product page URL… Higgsfield builds the ad from what's already on the page — you review, pick a template, and generate" — [Higgsfield blog: instant ads](https://higgsfield.ai/blog/how-to-create-instant-ads) (search snippet); the academy version is dated 2026-06-21 — [Higgsfield Academy](https://higgsfield.ai/academy/how-to-use/how-to-create-instant-ads)
- Marketing Studio, from a help article dated 2026-08-01 and summarized by aliteq:
  - Product Link produces a vertical ad for TikTok, Reels and Shorts. If the link fails, you can upload product images or describe the product.
  - An "Ad Reference" path takes a reference ad "you have rights to" and "recreates the reference's structure and format with your product in place of the original".
  - Seven template categories: Product Shot, Ads and Marketplace produce images; UGC, Motion and TikTok produce video.
  - Avatars come from the gallery, an AI Influencer, or your own; reusing one keeps the same face.
  - Video clips are 12 or 15 s at 480p, 720p or 1080p.
  - Source: [aliteq: Higgsfield UGC ads](https://aliteq.com/higgsfield-ugc-ads)
- New features in autumn 2026: Ads Studio (2026-09-30) turns a website link into up to 20 static ad creatives per product per batch. Ad Multiplier (2026-10-06) "recreates a video ad with your own characters, products and locations" — [aliteq](https://aliteq.com/higgsfield-ugc-ads)

**invideo: "agentic video editor" (Agent Two)**
- Accessed 2026-10-31: "The agentic video editor for serious creatives".
  - Four-step flow: "Upload footage → Describe edit → Review cut → Export".
  - One instruction can apply to "every shot on the timeline", and users can "take over at any frame".
  - External agents can drive the editor: Claude Cowork, ChatGPT Codex, Grok or Gemini.
  - Models: Seedance 2.0/2.5 and Nano Banana Pro. Agent tiers: Agent Two Lite, Pro and Ultra.
  - Source: [invideo homepage](https://invideo.io/)
- invideo's AI ad pages say the user describes product, audience and offer, and the agent builds the ad "on an editable timeline including script, visuals, voiceover, music and captions". The user can then "ask the agent to trim a beat or reorder the shots, or make the cut yourself" — [invideo AI ad generator page](https://invideo.io/make/healthcare-marketing/) (search snippet)
- The older "Magic Box" took text commands such as delete scenes, mute audio, change the voiceover or accent, or add an intro — [Unite.AI review](https://www.unite.ai/uk/invideo-review/) (search snippet; product names have changed several times)

**Captions → Mirage (Ad Studio / AI Ads)**
- Captions has rebranded as Mirage, and Mirage Studio was merged into Captions — [NetInfluencer](https://www.netinfluencer.com/captions-rebrands-as-mirage-in-pivot-to-ai-video-research/); [captions.ai/mirage](https://captions.ai/mirage)
- Ad Studio "powered by Mirage" works from a product URL: edit the details and script, choose an avatar, generate. Ad scripts are "limited to 1 minute" and 10–800 characters (doc dated 2026-08-18 per the snippet). The Mirage model generates "original actors" and replaces the older Lipdub-based AI Actors — [Captions Help: Ad Studio](https://help.captions.ai/docs/project/ad-studio-mirage); [Mirage Help: Ad Studio](https://help.mirage.app/docs/project/ad-studio) (both search snippets; the fetcher was blocked)
- Third-party: AI Ads generates multiple UGC-style variants for Meta and TikTok — [Vantaige](https://vantaige.io/ai-tool/captions-ai) (aggregator)

#### China

**ByteDance 小云雀 Xiaoyunque: the best-documented consumer 爆款复刻 agent**
- v2.0 (launched about 2025-11-30) has a "复刻爆款视频" entry: copy a Douyin, Toutiao or Xigua link and paste it in.
  - It "自动解析原视频的结构、风格、脚本和关键元素", then asks for preferences (protagonist style, comedic vs natural lines, music mood).
  - It then "直接生成一套完整的分镜…把原视频的节奏、转场逻辑和画面语言重新整理成可复刻的结构".
  - The whole workflow took "不到五分钟".
  - It asks for a brand name at the start and adds a brand end card automatically.
  - Source: [腾讯新闻 / 十字路口 Crossing, 2025-12-01](https://view.inews.qq.com/a/20251201A02WSS00)
- Its "智能生视频" mode (uploaded assets plus a voiceover script) produced a marketing storyboard with timed beats: 开场吸引 3.2s → 产品展示 6.2s → 口碑验证 6.6s → 渠道保障 5s → 个人推荐 3.2s → 行动号召 3.8s (about 28 s in total) — [腾讯新闻](https://view.inews.qq.com/a/20251201A02WSS00)
- 新榜's test (2025-12-10):
  - A link or uploaded reference is analyzed into "爆款DNA" (theme, structure, copy rhythm, visual style), and a new video is generated from it. A 30-s video was produced "在几分钟内".
  - The execution UI is split into 理解分析, 创意策略 and 剪辑成片, each with a 修改 button.
  - Models: Seedream 4.5 and OmniHuman 1.5.
  - Source: [新榜 on 知乎](https://zhuanlan.zhihu.com/p/1981928675839603394)
- A July 2026 review says link parsing automatically breaks out 分镜、转场、BGM 节奏. It also notes limits: only people (not physical products) can be replaced reliably, output is 9:16 only, and AI voiceover is forced — [知乎 2026 AI视频复刻横评](https://zhuanlan.zhihu.com/p/2057469725446256183) (the article promotes a competitor, 录咖)
- 2026-10-28: ByteDance folded Xiaoyunque into Dreamina (即梦) inside CapCut. It keeps a separate entry point and the same team, and "Dreamina has already integrated Xiaoyunque's microdrama capabilities" — [KrASIA, 2026-10-28](https://kr-asia.com/bytedance-folds-xiaoyunque-into-dreamina-as-it-consolidates-ai-apps)

**ByteDance 即梦 Jimeng / Dreamina: Agent mode**
- Agent mode launched around 2025-09-16. You switch modes at the input box and state your need; the agent writes the prompts for fully automatic creation. "智能多帧" generates consecutive frames with first and last frames auto-joined, for animation — [Threads post @ai_tjb](https://www.threads.com/@ai_tjb/post/DOpleMiimcs); [Douyin demo, 2025-09-16](https://www.douyin.com/video/7550494005545536807) (social-media sources only)
- Dreamina's tools include an "intelligent canvas" and "agent-assisted editing" — [KrASIA](https://kr-asia.com/bytedance-folds-xiaoyunque-into-dreamina-as-it-consolidates-ai-apps). Dreamina's own guide shows an "AI Agent" option in the top menu (undated) — [Dreamina: best AI agents](https://dreamina.capcut.com/it-it/resource/best-ai-agents)
- 2026-10-27: Jimeng launched an AI short-drama studio that runs from script to characters and scenes, storyboard, video and post-production — [TechNode](https://technode.com/2026/10/27/bytedance-launches-ai-studio-for-short-drama-production/) (search snippet)
- Underlying model, Seedance 2.0 (February 2026): one generation can take four input types (image, video, audio, text), runs up to 15 s, and includes native sound and music — [知乎 Seedance 2.0 教程, 2026-02-12](https://zhuanlan.zhihu.com/p/2004523300588643639). Audio and video are generated jointly — [Volcengine Seedance 2.0 提示词指南, 2026-09-22](https://www.volcengine.com/docs/82379/1587797)

**ByteDance 剪映 / CapCut**
- Launch event on 2026-09-20:
  - 剪映专业版 gained a "剪映 Hub" workspace.
  - The 智能创作 Agent "剪映助手" "可基于用户指令自动生成剪辑方案，支持多轨道同步调整与智能特效匹配".
  - The mobile assistant "小映" recognizes footage, recommends templates, takes voice commands, writes marketing copy and 分镜脚本, and acts as an "AI营销专家" for e-commerce.
  - "剪同款" was rebuilt on an AI Skill library.
  - Source: [搜狐 (via cnu.com.cn), 2026-09-20](https://www.sohu.com/a/1078654021_121850782)
- Before that update, a July 2026 review said 剪映 had no standalone AI 复刻 module, only 拍同款 / AI成片 plus manual cutout, which copies filters, transitions and BGM but not camera movement — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)

**ByteDance 巨量引擎 即创 (ad-creative platform) and AIGC 动态创意**
- 即创正式版 (January 2025): AI脚本生成、智能成片、数字人、商品卡、"爆款裂变"、"一键过审" — [AITOP100](https://www.aitop100.cn/infomation/details/19932.html)
- 即创数字人 produces material in 3–5 min and tracks Douyin trends. It also offers 投前检测, 一键过审 and 爆款裂变 — [胖鲸, 2025-06-04](https://pangjing.cn/6102584); [凤凰网科技](https://tech.ifeng.com/c/8juWkyawqPa)
- "AIGC 动态创意" is a switch inside the ad-delivery platform. Once on, the system generates, optimizes and delivers video creatives automatically — [搜狐, 2025-12-10](https://www.sohu.com/a/963670927_121663095)
- 即创 is built on the 抖音云雀 model — [Yiban tool directory](https://ad.yiban.io/operate/tool/1169); [即创 official site](https://aic.oceanengine.com)

**Kuaishou 可灵 Kling**
- 灵动画布 Agent 模式 (2026-01-30) adds:
  - 一键分镜: a story becomes a full storyboard plus subject and scene images.
  - 多视角扩展: other shot sizes and angles are inferred from one reference image.
  - 电商组图: one product photo becomes main, model and scene images, plus product showcase videos.
  - 高并发批量生成 and 多轮对话智能编辑.
  - A storyboard-consistency SOP ("故事目标→镜头拆解→输出优化").
  - Video and image "反推提示词" (reverse prompting).
  - Source: [搜狐 / AITOP100, 2026-01-30](https://www.sohu.com/a/981977307_122496371); release note at [Kling release notes](https://www.klingai.com/release-note/release-history) (search snippet; the page is JS-rendered)
- Kling Video 2.6 was pitched for "one-click generation of short ads featuring narration, character dialogue, and product showcases with comprehensive sound effects" — [Kuaishou IR](https://kuaishou.gcs-web.com/news-releases/news-release-details/kling-ai-launches-video-26-model-simultaneous-audio-visual)
- The Kling site promotes "让 Agent 调度可灵，灵感批量出片…一次生成多版本测试风格" — [Kling AI page](https://klingai.com/img-effects/ai-snow) (search snippet)
- Kling 4.0 had a preview on 2026-09-28 and launched globally in October 2026 — [Wikipedia: Kling AI](https://en.wikipedia.org/wiki/Kling_AI) (only source found)

**Alibaba 阿里妈妈: 万相妙应 Agent 2.0 (entry via 万相台无界 / 万相营造)**
- 2026-05-27:
  - One sentence such as "给我的连衣裙做一套种草素材" triggers 智能抓图, indoor and outdoor try-on images, selling-point images, a 展示视频 and 剪视频, and outputs images, videos and titles automatically.
  - It recognizes the store's audience and generates 千人千面 variants.
  - It remembers preferences, for example 800×800 images, indoor scenes and a career-women audience.
  - It claims 上架效率 ×3, and was free for a limited time.
  - Source: [淘宝教育](https://daxue.taobao.com/information/detail.jhtml?id=1537)
- 2026-09-10 (服贸会): 阿里妈妈 released 万相点睛 (AI audience targeting) and 万相妙应 — [新浪财经](https://finance.sina.com.cn/stock/relnews/hk/2026-09-11/doc-inirkcsq7567944.shtml) (headline and snippet only; the page fetch failed)

**MiniMax 海螺 Hailuo: Media Agent**
- A Video Agent beta launched in June 2025, built on templates that turn text or images into video — [mpost](https://mpost.io/minimax-unveils-hailuo-video-agent-and-voice-design-expanding-its-multimodal-ai-capabilities/)
- 2025-10-28:
  - It became the "Media Agent" and launched worldwide alongside Hailuo 2.3.
  - Modes: "one-click video generation", or step-by-step for professionals who upload images, video or audio. It picks multimodal models automatically.
  - Showcase: a 30-s tortilla-chip ad ("Casa Nacho") generated from scene, color tone, camera style and music inputs.
  - Planned: adjusting any pipeline step on a canvas through conversation.
  - Source: [MiniMax news](https://www.minimax.io/news/minimax-hailuo-23)

**生数科技 Vidu: Vidu Agent**
- A marketing-focused agent (global beta from December 2025).
  - Flow: (1) choose a scenario such as 电商广告, (2) upload product images or materials, (3) describe the need in plain language. It understands style words such as "高级感 / 科技酷炫 / 夏日清新".
  - It then matches shots, voiceover, music and transitions automatically, producing "15-30秒带配音成片".
  - "视频复刻" parses an uploaded reference for structure, rhythm and style.
  - An enterprise Agent API uses "多智能体深度协同".
  - Company claims: 40M+ users, 10k+ enterprise and developer customers, 500M+ videos, and more than 70% of output is commercial content.
  - Source: [知乎 (promotional), 2025-12-29](https://zhuanlan.zhihu.com/p/1988984388596307822)
- The Vidu Agent page says it "结合 OpenClaw 框架与 AI 自动化能力，把内容创作和营销流程整合到一个系统里" — [Vidu Agent](https://www.vidu.com/zh/vidu-claw) (search snippet)

#### Dedicated 爆款复刻 tools and APIs
- **录咖 App (mobile):** a reference video (5–180 s), 1–7 product or model images and a prompt (up to 2,000 characters). It replicates 运镜, 主体动作, 画面色调 and 剪辑节奏, and replaces only the product. Aspect ratios 9:16, 16:9, 1:1, 3:4 and 4:3; resolutions 540p, 720p and 1080p; original audio can be kept or removed — [知乎横评, 2026-07-06](https://zhuanlan.zhihu.com/p/2057469725446256183) (promotional for 录咖)
- **OiiOii (web):** "拉片复刻" breaks a reference down across 18 dimensions (storyboard, lighting, camera movement, composition). It can replace scenes, characters and props, generates 3-min+ videos, and is sold as an enterprise annual subscription — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **鲸剪 WhaleClip:** paste a TikTok or YouTube link; multilingual lip-synced dubbing; produces dozens of variants in a batch. It advertises "自带原创去重机制" to "规避海外平台原创检测" — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **PixPix Video Replication (2026-08-18):** 1–3 product images (front, side, detail, in use) plus a reference video. The user sets replication mode, target market, language, aspect ratio and selling points, generates, then checks consistency — [太平洋科技](https://pcedu.pconline.com.cn/2180/21805539.html); [中华网 (same text)](https://m.tech.china.com/jujiao/2026/0820/1945327.html)
- **WeShop AI 视频复刻:** inputs are a 视频参考, a 图片参考 and text (product name, selling points, visuals, BGM, voiceover, style) — [WeShop](https://www.weshop.ai/zh-Hans/apps/video-replication)
- **Tencent Cloud MPS "爆款复刻" API (`CloneViral`):**
  - Purpose: "输入爆款参考视频+商品图，生成风格/节奏对齐的视频".
  - The minimal request is `VideoUrl` plus `Product.Images[]`.
  - It runs asynchronously and returns a TaskId (`…-ViralCloneAsync-…`), with a limit of 20 requests per second.
  - A sample error reads "AIGCParam.Duration must in [4, 15]". The doc was updated 2026-10-19.
  - Source: [腾讯云 API 文档](https://cloud.tencent.com/document/api/862/135033)
- **ClipTrend (cliptrend.ai):** the user picks a trend template, uploads a selfie or pastes a TikTok link, and gets a clip in "30-60 秒". There is no prompt and no model choice — [ruanyf/weekly issue, 2026-05-02](https://github.com/ruanyf/weekly/issues/9827) (self-submitted)

### Inferences
- **Decision count and iteration model by product.** This table is compiled from the findings above and is approximate.

| Product | Entry input | Explicit decisions before first render | Iteration model |
|---|---|---|---|
| TopView Viral Video Agent / Canvas | product image + reference clip (or URL/prompt) | ~2 (reference, product image) + optional style/tone in prompt | chat agent + per-shot Canvas editing |
| Creatify Agent / Ad Clone | business URL, or reference ad + product | ~1–2 (vendor claim) | agent + built-in editor |
| Arcads | script | 2 (script, actor) | form |
| HeyGen Video Agent | prompt (+ files) | 1 in `generate`; optional avatar/voice/style/brand kit | one-shot, or `chat` with review pauses |
| Pexo | prompt/URL/files | 1 + plan review | chat, with comment-style revisions |
| Higgsfield Click to Ad | product URL | 2–3 (review draft, template, avatar) | form; changing a video means regenerating it |
| Mirage Ad Studio | product URL | ~3 (details/script edit, avatar) | form |
| invideo | footage / brief | 1 (describe the edit) | agent + timeline |
| 小云雀 爆款复刻 | Douyin link or upload | ~3–4 (link, style/tone/music preferences, brand name) | stage gates with 修改 + keyframe editor |
| Vidu Agent | scenario + product image + one sentence | 3 | chat |
| Kling 灵动画布 Agent | story / product image | 1 + multi-turn | canvas + chat |
| 万相妙应 Agent 2.0 | one sentence (store context + memory) | 1 | chat agent with preference memory |
| 录咖 / PixPix | reference + 1–7 images + settings | ~4–6 (aspect, resolution, audio, market, language, selling points) | form |
| Tencent `CloneViral` API | `VideoUrl` + `Product.Images` | 2 (minimum) | API (async) |
| MiniMax Media Agent | prompt (+ uploads) | 1 (one-click) or stepwise | one-click or step-by-step |

- **A common pipeline.** Most products follow "brief → plan/storyboard → per-shot model routing → assembly (voiceover, music, captions) → chat/canvas revision". Pexo, TopView, HeyGen, Vidu and MiniMax all describe this shape. The orchestrator is the product; the video models are shared (Seedance appears in TopView, Pexo, invideo, Creatify and HeyGen's "Seedance mode").
- **Visible plans build trust.** Chinese agents expose the stages (小云雀's 理解分析 / 创意策略 / 剪辑成片, each with 修改) and Western agents expose plans (Pexo's Plan → Storyboard, HeyGen's `chat` mode pausing for review). For our chat agent this suggests an explicit, editable storyboard checkpoint before spending generation credits.
- **Output length is set by model clip limits.** Seedance 2.0 clips run up to 15 s, Higgsfield clips are 12 or 15 s, and Tencent's `CloneViral` outputs 4–15 s. A 30-s ad therefore needs at least two generated shots stitched together, with continuity handled by the orchestrator.
- **Products are exposing themselves to outside agents.** TopView offers MCP/Skill, Pexo ships a Claude Code skill, invideo lets Claude Cowork, Codex, Grok or Gemini drive its editor, Higgsfield exposes an MCP cost check (per aliteq), and Vidu offers an Agent API and references OpenClaw. A chat agent could consume these as external skills, which is relevant to our rubric's 100-point "external skills (SKILL.md)" item.
- **HeyGen renders from code.** Its Video Agent composes graphics with an HTML-to-video framework (Hyperframes) on top of generated avatar footage. That is evidence that a production ad agent can mix generative footage with motion graphics rendered from code, which matches the project's "video rendered from code" reference.

### Gaps
- **TopView:** plan prices, credits per clone, and output-length limits for the Viral Video Agent were not found. Which model powers cloning (Sora 2 vs Seedance) is inconsistent across third-party sources.
- **Creatify:** three claims came only from search summaries with uncertain attribution and could not be verified: AdMax launched in May 2025 as an "end-to-end AI Ad Agent"; "Creatify Agent" launched in May 2026 as a "conversational, checkpointed workflow"; and an "Ad Agent" replaced "Creative Agent" per a help article dated 2026-10-04.
- **Arcads:** there is no official public pricing or feature documentation, and no clone or variation feature was confirmed.
- **Captions/Mirage:** the help pages blocked the fetcher, and Ad Studio pricing is unknown.
- **即梦 / Dreamina:** no primary 2026 source describes the Agent mode's ad flow. It is unknown whether 小云雀's 爆款复刻 is available inside 即梦 after the October 2026 merger.
- **Kling:** no ad-specific Kling agent was found. A 2026-10-17 snippet said Kling 4.0 generates up to 30 s per pass, takes up to 10 keyframes, outputs 4K 10-bit HDR and 21:9, and accepts 8,000-token prompts, but the URL could not be resolved, so this is unverified.
- **剪映:** no detail was found on a product-link-to-ad flow or an "AI 广告" feature. A 36氪 article (2026-09-20) on 剪映 Hub and 剪映助手 could not be retrieved.
- **即创:** no 2026 爆款复刻 module was found.
- **阿里:** two items were seen only in snippets with unresolvable URLs: Aliyun's "电商视频生成" doc (2026-10-09; "5–30秒商品展示短视频" from main image, title and selling points) and 阿里妈妈's "万相智造" creative agent (2026-03-20).
- **Hailuo:** no 2026 update on the Media Agent was found.
- **Vidu:** current Agent status (beta or GA) and pricing are unknown.

## Q2. How "clone a viral video" (爆款复刻) works technically: what is extracted, copied vs replaced, product insertion, safeguards

### Takeaway
There are two technical approaches, and they are often combined. **(A) Blueprint clone:** a multimodal LLM breaks the reference into a structured storyboard (hook or first 3 s, beat timings, shot types and camera language, transitions, caption style, music cue points, voiceover script), rewrites it for the new product and brand, and regenerates every shot. Examples: 小云雀, Creatify Ad Clone, Vidu, TopView's agent. **(B) Reference-conditioned regeneration:** the reference clip itself is a conditioning input to the video model (video-to-video, reference-video or motion/pose/camera control, multimodal reference as in Seedance 2.x), with product images as subject references. Camera moves, actions, rhythm and color carry over while the product is swapped. Examples: 录咖, WeShop, Tencent `CloneViral`, TopView's "follow the reference… swap the advertised item" prompt. Originality safeguards are thin: a few rights statements and usage guidelines, plus mandatory AIGC labeling in China. No product was found to run automatic similarity or IP checks, and at least one cross-border tool advertises "去重" to evade originality detection.

### Cited Findings

#### What gets analyzed or extracted from the reference
- **TopView** analyzes "the style, rhythm, shot structure, camera language, and hooks" and describes itself as "Analyzes pacing, shots, hooks, and structure" — [TopView homepage](https://www.topview.ai/). The launch PR says it identifies "storytelling, pacing, and emotional triggers" and breaks references into "storytelling and visual components" — [Retail Dive PR, 2025-11-13](https://www.retaildive.com/press-release/20251113-virality-becomes-a-system-topview-ai-launches-viral-video-agent-for-market)
- **Creatify:**
  - The Ads Clone help article says the AI "analyzes key creative elements" (the list did not render; a search snippet says it covers branding, colors, music, captions and CTA) — [Creatify Help](https://help.creatify.ai/en/articles/15049358-ads-clone)
  - A 2026 tutorial says you paste a competitor ad link and your product link, and the tool "breaks down the hook, angle, and pacing" and rebuilds the ad with your product, images and offer — [Creatify 2026 tutorial](https://creatify.ai/blog/how-to-clone-your-competitors-winning-meta-ads-with-ai-in-5-minutes-2026-tutorial) (search snippet)
  - The feature page says it "extracts the structure, rewrites the script for your product, and produces versions with different avatars and visual styles". It can also suggest trending ads from similar products once you enter your product URL — [Creatify Ad Clone page](https://creatify.ai/features/ad-clone) (search snippet)
  - The AI Ad Library shows a "reuse" count to help pick proven templates, then offers "Clone this ad" — [Creatify blog](https://creatify.ai/blog/how-to-clone-your-competitors-winning-meta-ads-with-ai-in-5-minutes) (search snippet)
- **小云雀:**
  - Parses "结构、风格、脚本和关键元素", then rebuilds the 分镜 — [腾讯新闻](https://view.inews.qq.com/a/20251201A02WSS00)
  - 新榜 describes the extracted "爆款DNA" as "主题、结构、文案节奏到视觉风格", and frames the analysis as "黄金前三秒怎么留人…情绪钩子怎么埋…运镜与音乐的卡点逻辑"
  - The process is "先拆解原视频结构，再将用户通过提示词输入的创意转化为具体内容…模仿的不是爆款内容的'皮'而是'骨'" — [新榜](https://zhuanlan.zhihu.com/p/1981928675839603394)
  - Link parsing breaks out "分镜、转场、BGM节奏" — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **OiiOii** breaks a reference down across 18 dimensions ("分镜、光影、运镜、构图") — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **Kling Agent** reverse-prompts from video or images: it "精准提取输入素材的视觉风格与核心元素，自动生成高质量 Prompt" — [搜狐 / AITOP100](https://www.sohu.com/a/981977307_122496371)
- **Vidu Agent "视频复刻"** "自动解析结构、节奏、风格" — [知乎 Vidu](https://zhuanlan.zhihu.com/p/1988984388596307822)
- **PixPix guidance:**
  - Analyze the first 3 seconds: does it open with a question, a person, or the product?
  - Then note when the product appears, which action expresses the selling point, and how the video ends. "这些内容结构比单纯模仿画面颜色和布景更有价值".
  - Source: [太平洋科技](https://pcedu.pconline.com.cn/2180/21805539.html)
- **WeShop** lists the techniques it uses: video-to-video, reference-video control, motion control, pose control, style transfer, camera-movement replication and temporal consistency. It reshapes "开场镜头、场景顺序、节奏、过渡、拍摄角度和结束帧" — [WeShop 视频复刻](https://www.weshop.ai/zh-Hans/apps/video-replication)

#### How the new product is inserted
- **TopView's template prompt** (2026), as given in its featured case: "Clone this viral product ad / Product Image: <<<Image1>>> / Reference Video: <<<Video1>>> / Reference Usage: Follow the reference video for pacing, shot rhythm, captions, and hook structure / Replacement: Swap the advertised item in the reference video with <<<Image1>>> / Ad Style: High-end lifestyle unboxing, UGC / Tone / Energy: Keep the overall viral-ad energy". Choosing "使用此案例" copies the source Canvas so the user can change shots, assets or models — [TopView 精选案例: 复刻这条爆款产品广告](https://www.topview.ai/zh/featured-cases/clone-viral-product-ad)
- **Tencent `CloneViral`:** the product enters as `Product.Images[]` alongside the reference `VideoUrl` — [腾讯云](https://cloud.tencent.com/document/api/862/135033)
- **PixPix:** 1–3 clear images from different angles (front, side, detail, in use) so the product stays consistent across shots; avoid near-duplicate front shots. Selling points should be visualizable ("无线便携榨汁杯，一键启动…") rather than generic slogans — [太平洋科技](https://pcedu.pconline.com.cn/2180/21805539.html)
- **录咖:** 1–7 product or model images; "仅替换上传的商品素材" — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **Higgsfield:** Ad Reference "recreates the reference's structure and format with your product in place of the original". Ad Multiplier swaps in your own characters, products and locations — [aliteq](https://aliteq.com/higgsfield-ugc-ads)
- **小云雀:** asks for the brand name and generates a brand end card — [腾讯新闻](https://view.inews.qq.com/a/20251201A02WSS00). It also swapped the brand to Coca-Cola while keeping "和原片非常相近的视觉风格和剪辑节奏" — [新榜](https://zhuanlan.zhihu.com/p/1981928675839603394)
- **The model capability behind this:** Seedance 2.0 takes images, video, audio and text together in one generation (up to 15 s) — [知乎 Seedance 2.0 教程](https://zhuanlan.zhihu.com/p/2004523300588643639)

#### What is copied vs. replaced
- **录咖:** copies 运镜、主体动作、画面色调、剪辑节奏; replaces only the product; the original audio can optionally be kept — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **小云雀:** keeps rhythm, transition logic and visual language. The script, scenes and voiceover are new: "从文案脚本到画面场景，再到旁白配音，都和参考视频完全不一样" (example: a children's-science reference rewritten on "户外运动") — [新榜](https://zhuanlan.zhihu.com/p/1981928675839603394)
- **TopView:** keeps pacing, shot rhythm, captions, hook structure and "viral-ad energy"; swaps the advertised item — [TopView case](https://www.topview.ai/zh/featured-cases/clone-viral-product-ad)
- **WeShop:** keeps "动作、时序和镜头逻辑"; changes "角色、场景、光影、风格或背景" — [WeShop](https://www.weshop.ai/zh-Hans/apps/video-replication)
- **剪映 (pre-September 2026):** template reuse copies only filters, transitions and BGM, not camera movement or product motion — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)

#### Copyright and originality safeguards (or their absence)
- **Higgsfield** asks for a reference ad "you have rights to" — [aliteq](https://aliteq.com/higgsfield-ugc-ads)
- **WeShop FAQ:**
  - "视频复刻不应意味着直接复制受版权保护的素材、音乐、Logo、角色或品牌资产…更安全的流程是…复刻其结构、动作或创意风格".
  - For TikTok and Reels clones: "应该避免复制完全相同的原始素材、音乐、创作者肖像、水印或受保护的品牌资产".
  - Source: [WeShop](https://www.weshop.ai/zh-Hans/apps/video-replication)
- **TopView's launch PR** makes no copyright or originality statement. The closest is the CEO's "We're not replacing creativity — we're systemising it" — [Retail Dive PR](https://www.retaildive.com/press-release/20251113-virality-becomes-a-system-topview-ai-launches-viral-video-agent-for-market)
- **小云雀:** the tester had to instruct it explicitly to avoid infringement and replace 蜡笔小新-style characters with "近似但不一样的角色形象". It complied, but there is no evidence of automatic IP filtering — [腾讯新闻](https://view.inews.qq.com/a/20251201A02WSS00). 新榜 argues the clone "本质上并不涉及直接搬运和洗稿" because it copies structure, not content — [新榜](https://zhuanlan.zhihu.com/p/1981928675839603394) (a framing friendly to the vendor)
- **鲸剪 WhaleClip:** markets "原创去重" to "规避海外平台原创检测", the opposite of a safeguard — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **China regulation:** the CAC and three other agencies' 《人工智能生成合成内容标识办法》 (published 2025-03-14, effective 2025-09-01) requires both explicit and implicit labels on AI-generated text, images, audio and video — [国家网信办答记者问](https://www.cac.gov.cn/2025-03/14/c_1743654685896173.htm). Six major Chinese social platforms launched "AI 生成" badges and implicit metadata labels. Creators must self-label, and platforms auto-detect and add labels — [PwC China](https://www.pwccn.com/zh/tmt/method-identifying-synthetic-content-generated-ai-sep2025.pdf)
- **US context:** aliteq's Higgsfield page notes that the FTC consumer reviews and testimonials rule (effective 2024-10-21) is relevant to AI-UGC testimonial ads — [aliteq](https://aliteq.com/higgsfield-ugc-ads)
- **Creatify's disclaimer** covers ad performance only ("do not guarantee specific advertising results"), not IP — [Creatify Help](https://help.creatify.ai/en/articles/15049358-ads-clone)

### Inferences
- **A design for our clone flow (flow 4).**
  - Analysis step: from the reference, produce the same storyboard schema our brief-to-ad flow (flow 1) uses: beats with timestamps, a hook type for the first 3 s, a per-shot description (shot size, camera move, subject action), caption style and timing, music cue points, and a voiceover transcript (via ASR), plus on-screen text (via OCR).
  - Rewrite step: a structure-preserving script adapted to the new product.
  - Generation: per shot, with product images as references, and optionally the matching reference segment as motion or camera guidance where the provider supports it (Seedance-class multimodal reference).
  - Why this design: it supports both approach A and approach B, and lets later chat edits (flows 2–3) work on the same storyboard.
- **Ask a few preference questions before generating.** 小云雀 asks about tone, music mood, protagonist style and brand name before generating. Two or three such questions seem to be the norm for keeping decisions low while avoiding wasted renders.
- **What to keep and what to replace.** The market converges on keeping pacing, hook pattern, shot grammar, caption style and energy, and replacing product, claims, brand, people, music and literal footage. That boundary is also what WeShop's guidance and Higgsfield's rights requirement imply. A reasonable policy for our agent: always regenerate footage, never reuse the reference audio track or logos by default, require the user to confirm they have rights to the reference, and add AIGC labels (required in China since 2025-09-01).
- **Product consistency is the main quality risk.** PixPix's post-generation checklist (logo, packaging, buttons, materials, colors across shots) and 录咖's "极少出现物体扭曲、穿模" marketing both point to it. An automated consistency check, such as a VLM comparing each shot against the product reference images, would be a useful built-in QA step.

### Gaps
- No vendor documents its actual shot-segmentation method (scene-cut detection, beat tracking, ASR/OCR pipeline). Descriptions are functional only. A Coze community workflow reportedly scrapes the title, ASR subtitles and OCR text from a video link to drive a rewrite, but it was seen only in a snippet with an unresolvable URL.
- No product was found to run automatic similarity checks, face or likeness detection, or music-rights checks on references or outputs.
- Platform policies on AI clones of other creators' videos (Douyin and TikTok "搬运" / originality rules) were not researched.
- Seedance 2.0's reference limits (reportedly up to 12 files: 9 images, 3 videos, 3 audio) appeared only in a search snippet with no resolvable URL.

## Q3. Editing after generation: subtitles, swapping a shot, music/voice changes, aspect ratio, A/B variants

### Takeaway
Revision works at three levels. (1) Conversational revisions apply to the plan or storyboard (HeyGen `chat` mode, Pexo comment-style feedback, Kling multi-turn editing, 小云雀 per-stage 修改). (2) Per-shot operations regenerate, replace or crop individual shots on a canvas or timeline (TopView Canvas, invideo, 小云雀's keyframe editor, Creatify's editor). (3) Variant fan-out produces multiple versions by language, SKU, hook, avatar or aspect ratio (TopView, Creatify, 录咖, PixPix, 万相妙应, 即创 爆款裂变). The weakest products still require regenerating the whole video to change it (Higgsfield).

### Cited Findings
- **HeyGen:**
  - `chat` mode "pauses for review and supports revisions".
  - Completed jobs return `captioned_video_url` and a separate `subtitle_url` as well as `video_url`, so subtitles are handled as their own layer and file.
  - `brand_glossary_id` fixes narration pronunciation while "Captions keep the original spelling".
  - Avatar, voice, style and brand kit can each be pinned by ID; orientation is a parameter.
  - Source: [HeyGen API docs](https://developers.heygen.com/docs/video-agent)
- **Pexo:** "Mark what you want to fix and make changes through conversation, just like commenting in a Google Doc"; it "Applies revisions naturally without restarting from scratch". Narration, music, subtitles and transitions are included — [Pexo homepage](https://pexo.ai/)
- **TopView:**
  - Every shot stays editable on Canvas. The toolset includes Video Character Swap, Subtitle Remover, Voiceover, AI Voice Cloning, AI Music Generator, AI Lip Sync, Video Upscale and Inpaint.
  - It supports "testing hooks, captions, aspect ratios, edits, and platform-native video formats" and offers "Voice, captions, and versions across 30+ languages" — [TopView homepage](https://www.topview.ai/)
  - Featured follow-on cases include "制作日语版", "匹配此视频的视觉风格" and "复用此视频脚本结构" — [TopView case](https://www.topview.ai/zh/featured-cases/clone-viral-product-ad)
  - The launch PR mentions A/B testing and "launching multiple variations" — [Retail Dive PR](https://www.retaildive.com/press-release/20251113-virality-becomes-a-system-topview-ai-launches-viral-video-agent-for-market)
- **Creatify:** a cloned ad is a "new editable ad" that users "can further edit… using Creatify's built-in tools before exporting" to TikTok, Reels, Facebook and Shorts — [Creatify Help](https://help.creatify.ai/en/articles/15049358-ads-clone). Parallel generations are 1, 5 or 10 depending on the plan, and the Pro tier includes the Competitor Ad Tracker and "Ad Agent + Automations" — [Creatify pricing](https://creatify.ai/pricing). The Ad Clone page says it produces versions with different avatars and visual styles — [Creatify Ad Clone](https://creatify.ai/features/ad-clone) (search snippet)
- **Higgsfield:** "Changing a video means generating it again"; images can be edited afterward; UGC voiceover and pacing "can vary by generation" — [aliteq](https://aliteq.com/higgsfield-ugc-ads)
- **invideo:**
  - One instruction applies across "every shot on the timeline" (for example "cutting the pauses", "matching the look"), and the user can "take over at any frame".
  - Third-party agents are shown doing "Ducking music under VO" and "Writing the captions".
  - Source: [invideo homepage](https://invideo.io/)
  - The ad flow lets the user ask the agent to "trim a beat or reorder the shots" — [invideo ad page](https://invideo.io/make/healthcare-marketing/) (search snippet)
  - The older Magic Box handled "delete scenes, mute audio, change voiceover/accent" — [Unite.AI](https://www.unite.ai/uk/invideo-review/) (search snippet)
- **小云雀:** "点击预览页右上角的'编辑更多'…自由地替换、重新生成或裁剪每一个关键帧画面", plus a 修改 button at each stage (理解分析 / 创意策略 / 剪辑成片) — [新榜](https://zhuanlan.zhihu.com/p/1981928675839603394). Constraints: 9:16 only and forced AI voiceover — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **Kling 灵动画布 Agent:** "多轮对话智能编辑" with context understanding, step-by-step text-to-image, image editing and batch image-to-image. Multiple jobs run in parallel and results are picked and downloaded in batches on the canvas — [搜狐 / AITOP100](https://www.sohu.com/a/981977307_122496371)
- **剪映:** 剪映助手 supports "多轨道同步调整与智能特效匹配", and 小映 takes "语音指令操控剪辑流程" — [搜狐](https://www.sohu.com/a/1078654021_121850782)
- **万相妙应:** remembers preferences (size, scene, audience) across sessions and generates 千人千面 variants for different audience segments — [淘宝教育](https://daxue.taobao.com/information/detail.jhtml?id=1537)
- **即创 and 巨量:** "爆款裂变" for variants and "一键过审" for pre-review — [AITOP100](https://www.aitop100.cn/infomation/details/19932.html). AIGC 动态创意 generates and optimizes creatives automatically during delivery — [搜狐](https://www.sohu.com/a/963670927_121663095)
- **录咖:** five aspect ratios and three resolutions, original audio kept or removed (so a trending BGM can be added later), and up to 7 product images per run so one template yields multiple SKU variants "适合…广告A/B测试" — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **PixPix:**
  - Keep the reference structure and generate separate versions by language, character or selling point.
  - "每个版本突出一个核心卖点，再通过多版本测试".
  - If some shots fail, adjust selling points or replication settings "而不是马上换掉整个参考方向".
  - Source: [太平洋科技](https://pcedu.pconline.com.cn/2180/21805539.html)
- **WeShop:** recommends generating multiple versions, and for longer videos "可以创建多个短片段并将其剪辑在一起" — [WeShop](https://www.weshop.ai/zh-Hans/apps/video-replication)
- **MiniMax:** planned a canvas where any pipeline step can be adjusted through conversation (as of 2025-10-28) — [MiniMax news](https://www.minimax.io/news/minimax-hailuo-23)

### Inferences
- **Treat the storyboard as the document that chat edits change.** Flows 2 and 3 work best if each user message is turned into a diff against a versioned storyboard: change copy, swap shot N, change voice or music, change aspect ratio, add or modify subtitles. Only the affected layers then re-render. HeyGen's separate subtitle file, invideo's "every shot" instructions and 小云雀's per-keyframe regenerate are concrete examples. Avoid Higgsfield's regenerate-everything model.
- **Keep subtitles, text overlays, end cards and music on code-rendered layers** (HeyGen's HTML-to-video approach) rather than baking them into generated footage. Subtitle fixes, translations and 9:16 → 1:1 or 16:9 reflows then become cheap and deterministic. Aspect-ratio changes for generated footage still need either reframing or regeneration.
- **Variant fan-out is standard.** A/B variants by hook, selling point, SKU, language, avatar or aspect ratio are a baseline feature (TopView, Creatify, 录咖, PixPix, 万相妙应, 即创). A chat command like "give me 3 hook variants" should map to parallel per-shot jobs.
- **Persistent preference memory** (万相妙应's sizes, scenes and audiences) is an under-used differentiator in Western tools that a chat agent can offer cheaply.

### Gaps
- No product documents swapping voice or music after generation in detail, beyond tool names (TopView Voiceover / Voice Cloning / Music Generator) and invideo's music-ducking example.
- Several items were not verified:
  - Mirage/Captions: an aggregator reported audio drifting out of sync after multiple AI edits, but the claim was seen only in a search summary with unclear attribution.
  - Creatify Agent's checkpoint UI was not seen.
  - HeyGen's Interactive Sessions page was not read, so revision granularity and cost are unknown.
- No source quantifies how often per-shot regeneration preserves character and product consistency.

## Q4. Pricing (per video / credits) and typical generation times

### Takeaway
Most products bill in credits that depend on model, resolution and length. Rough comparisons: about $11 per Arcads UGC video; TopView advertises Seedance 2.5 at $3.6 per 30 s; Higgsfield charges 42–195 credits per 12–15-s ad clip; Creatify sells $15–$195/month plans in which a 5-s Seedance 2.0 clip costs about 7.8 credits; HeyGen's Video Agent credit rate per minute has been raised repeatedly in 2026. Documented times to first video range from vendor claims of about 60 s (Creatify) and "minutes" (TopView, Vidu, 小云雀 under 5 min) to measured or documented 7–8 min (Arcads, Pexo under 8 min for 15 s) and 5–10× the video's length (HeyGen).

### Cited Findings
- **TopView:** the banner offers "Seedance 2.5 $3.6 / 30s". It also advertises "30-Day Unlimited" (Seedance 2.5, Topview T1) and "365-Day Unlimited" (Wan 3.0, MiniMax H3, GPT Image 2.5) plans — [TopView homepage](https://www.topview.ai/) (promotional; plan prices not retrieved). The launch PR says "in minutes" — [Retail Dive PR](https://www.retaildive.com/press-release/20251113-virality-becomes-a-system-topview-ai-launches-viral-video-agent-for-market)
- **Creatify** (accessed 2026-10-31):

  | Plan | Monthly | Annual (per month) | Credits/month |
  |---|---|---|---|
  | Standard | $15 | $10 | 55 |
  | Pro | $55 | $38 | 280 |
  | Max | $95 | $66 | 730 |
  | Business | $195 | $136 | 1,500 |
  | API Starter | $99 | – | 500 |
  | API Pro | $299 | – | 2,000 |

  - Implied costs per output: about 7.8 credits per 5-s Seedance 2.0 clip, and about 5 credits per 15-s "Aurora" avatar video.
  - Free tier: 10 credits per month (up to 2 video ads, watermarked).
  - Credits expire after 2 months. The Studio service has a 48-hour turnaround.
  - Source: [Creatify pricing](https://creatify.ai/pricing)
  - The Agent claims an ad "in about 60 seconds" — [Creatify blog, 2026-06-17](https://creatify.ai/blog/i-turned-one-url-into-a-5-scene-converting-ad-in-60-seconds-creatify-agent). Clone credit use "varies" — [Creatify Help](https://help.creatify.ai/en/articles/15049358-ads-clone)
- **Arcads** (third-party figures, which conflict):
  - $110/month for 10 videos (about $11 each) and $220/month for 20 (Creator); Pro is custom-priced with API access — [Fluxnote](https://fluxnote.io/guides/arcads-pricing-2026)
  - Another source says $110/month buys 8,000 credits for "up to 50" videos, with an unpublished credit model — [Wireflow](https://www.wireflow.ai/blog/arcads-pricing)
  - A competitor's review says Lite costs $29, the talking-actor workflow starts at a discounted $77 Starter plan, and failed generations are refunded — [Creatify review of Arcads pricing](https://creatify.ai/blog/arcads-pricing-%282026%29-plans-credits-and-what-you-ll-actually-pay)
  - Generation took about 7–8 min per video — [Predis.ai](https://predis.ai/review/arcads/)
- **HeyGen:**
  - Processing "typically takes 5x–10x the final video length" (about 5–10 min for a 1-min video); Enterprise plans get a priority queue — [HeyGen API docs](https://developers.heygen.com/docs/video-agent)
  - Studio credit rates for Video Agent conflict across trackers:
    - 20 credits/min (May 2026) — [Usagepricing: HeyGen](https://usagepricing.com/blueprint/heygen)
    - 30/min standard and 90/min "Seedance mode" (2026-07-22) — [Usagepricing change log](https://usagepricing.com/blueprint/activity/heygen-2026-07-22-price-change)
    - 40/min standard and 120/min Seedance (September 2026) — [Luma Labs](https://lumalabs.ai/news/heygen-pricing); [DIYAI](https://diyai.io/ai-tools/video-generation/heygen-pricing/)
    - 80/min (2026-10-15) — [Usagepricing](https://www.usagepricing.com/blueprint/activity/heygen-2026-10-15-avatar-credit-rate-increase) (not confirmed by HeyGen)
  - The API rate for prompt-to-video is $0.0333/s (about $2/min) per [DIYAI](https://diyai.io/ai-tools/video-generation/heygen-pricing/); [aividpipeline](https://aividpipeline.com/zh/blog/heygen-video-agent-guide-2026) reports a different figure (about $0.15/s). The sources conflict.
- **Pexo:** a typical 15-s, 3-shot product ad renders in under 8 min (skill listing) — [skillselion](https://skillselion.com/skills/pexoai/pexo-skills/video-ad). Each video costs credits based on model and length — [Pexo skills](https://pexo.ai/skills) (search snippet). The pricing page did not render — [Pexo pricing](https://pexo.ai/pricing)
- **Higgsfield** (as read by aliteq on 2026-10-26):
  - Credits per clip: 12 s at 480p = 42; 15 s at 480p = 52.5; 12 s at 720p = 60; 15 s at 720p = 75; 15 s at 1080p = 195. That is about 3.5, 5 and 13 credits per second at 480p, 720p and 1080p.
  - Plans: Plus is $47/month billed yearly or $59 monthly. Ultra is $99/month billed yearly or $129 monthly, with 3,000 credits.
  - The UGC builder and ads features are on Plus and Ultra only.
  - Source: [aliteq](https://aliteq.com/higgsfield-ugc-ads)
- **invideo** (per seat, annual billing): Starter $10/month with 400 credits (Agent Two Lite only); Plus $30 with 2,000 credits; Max $37.5 with 8,000 credits — [invideo homepage](https://invideo.io/)
- **小云雀** (as of July 2026): daily check-in earns 120 points, and "10积分≈1秒视频", so about 12 s of video per day free. Free exports are 720p with a watermark. Membership is 月卡 39元 or 高级会员 79元/月 for 1080p, no watermark, priority rendering and a commercial license — [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183). A clone workflow took under 5 minutes in testing — [腾讯新闻](https://view.inews.qq.com/a/20251201A02WSS00)
- **录咖, OiiOii, 鲸剪:**
  - 录咖 bills in 算粒 with merchant packages.
  - OiiOii has no free tier; the enterprise annual fee is "数千元".
  - 鲸剪 charges per video or monthly.
  - 录咖 slows down for references over 120 s.
  - Source: [知乎横评](https://zhuanlan.zhihu.com/p/2057469725446256183)
- **即创:** 智能成片 was launched free for Douyin merchants (2023) — [亿邦动力](https://www.ebrun.com/ebrungo/zb/526448.shtml). Digital-human material takes 3–5 min — [胖鲸](https://pangjing.cn/6102584)
- **万相妙应 Agent 2.0:** "当前阶段所有创意任务暂不扣除算力值" (free for a limited time, as of 2026-05-27) — [淘宝教育](https://daxue.taobao.com/information/detail.jhtml?id=1537)
- **MiniMax:** daily free trial credits during the Hailuo 2.3 launch; Hailuo 2.3 keeps Hailuo 02 pricing. The Media Agent's own price is not stated — [MiniMax news](https://www.minimax.io/news/minimax-hailuo-23)
- **Vidu Agent:** claims "几分钟甚至几秒" for a 15–30-s video; an invite code gives 500 points — [知乎 Vidu](https://zhuanlan.zhihu.com/p/1988984388596307822) (promotional)
- **Tencent `CloneViral`:** output duration is 4–15 s, the API is async, and the limit is 20 requests per second. Pricing is not on the API page — [腾讯云](https://cloud.tencent.com/document/api/862/135033)
- **Market context:** Kling AI revenue was over RMB 650M in Q1 2026 (up more than 300% year on year), and the 2026 ARR guidance was raised to $500M — [iTiger](https://www.itiger.com/news/1119092134)

### Inferences
- **Rough cost per 30-s ad from list prices.** These are my calculations from the figures above, ignoring retries and voiceover/avatar add-ons:
  - TopView Seedance 2.5: about $3.6 (promotional banner).
  - Higgsfield on Ultra: 75 credits per 15-s 720p clip at $99–$129 per 3,000 credits is about $2.5–$3.2 per clip, so about $5–$6.5 per 30 s.
  - Creatify Standard: $15 per 55 credits is about $0.27 per credit; 7.8 credits per 5-s Seedance clip is about $2.1, so about $13 per 30 s of Seedance footage (about $8.5 with annual billing).
  - HeyGen API at $0.0333/s: about $1 per 30 s, if that rate is correct.
  - Arcads: about $11 per video.
  - Retries (Higgsfield notes voiceover and pacing vary by generation) can multiply these figures.
- **Time to first video for a 15–30-s ad is roughly 1–10 minutes across agentic products.** Claims under one minute are vendor-only. For our chat UX this argues for streaming progress (plan → storyboard → per-shot progress), as HeyGen's statuses (`thinking`, `generating`, `completed`) and Pexo's staged flow do, and for asking for storyboard approval before the expensive per-shot generation.
- **Pricing is moving toward per-second rates by model tier.** Higgsfield charges per second by resolution, HeyGen's Seedance mode costs 3× standard, and Creatify prices per-model clips. An agent that picks models per shot can control cost by using cheaper models (Wan, MiniMax H3, Seedance Fast) for drafts and premium models for the final render; TopView's "Topview T1" and unlimited plans signal the same thinking.

### Gaps
- No official HeyGen rate card was found. Credits per minute changed several times in 2026 and the sources conflict. The "free API credits ended February 2026" claim was seen only in a search summary with uncertain attribution.
- No public pricing was retrieved for TopView plans, Pexo, Mirage/Captions Ad Studio, Vidu Agent, Kling 4.0, 即梦 Agent, 剪映 AI features, 即创 (2026) or Tencent `CloneViral`.
- OpenArt's reported "$14/month for 4,000 credits" entry plan (2025) came from a search summary with unclear attribution and may be outdated.
- No independent, side-by-side timing benchmark across products was found. All times are single tests or vendor claims.
