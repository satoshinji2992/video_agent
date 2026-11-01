# Frontier-lab conversational video creation: xAI (Grok Imagine Agent Mode, Grok Bot), Anthropic (Opus 5.5 code-to-video, Claude Motion), Google Flow, OpenAI Sora. State as of 2026-10-31

Source tags used below: **[OFFICIAL]** = the company's own page, post or docs. **[PRESS]** = tech press / news. **[3P-GUIDE]** = third-party blog, guide or SEO site (often unsourced). **[VENDOR]** = a company promoting its own integration. **[SOCIAL]** = X/Reddit/creator self-report. **(snippet)** = seen only in a search-result summary; the page itself was not fully read, so treat it with extra caution.

---

## Q1. xAI: How does Grok Imagine Agent Mode plan, generate, edit and stitch clips into longer videos (max lengths, consistency, prompt editing, references)? Does Grok Bot expose video creation inside its bot chats, and how does that conversation feel?

### Takeaway
Grok Imagine Agent Mode (beta, web only, rolled out 2026-04-30 to 05-01, **with no formal xAI blog post or docs**) moves the conversation off a linear chat and onto an infinite canvas. From one brief, an LLM agent lays out steps as nodes: plan/scenario, image variants, pick the best, image-to-video (about 6 s, 720p clips at launch), then Stitch with Trim/Fade/Crop, then export. Each node can be re-prompted or branched on its own. Consistency comes from reference images and style anchors, and a September 2026 guide says character drift is only "partly addressed". The underlying model got official multi-reference support on 2026-07-31: up to 7 refs at announcement, 14 in current API docs, each locking a face, product or location, plus voice references. The API offers 1–15 s generation, prompt-based **editing (source ≤8.7 s, ≤720p)** and **extension** endpoints. Grok Bot (beta 2026-08-11) is a general "always-on AI teammates" product, and its official launch page never mentions Imagine or video. **I found no evidence that Grok Bot creates video inside bot chats.**

### Cited Findings

#### A. Agent Mode: launch, status, access
- [PRESS] TestingCatalog, 2026-04-30: xAI "has begun rolling out" Imagine Agent as a beta on Grok web inside Grok Imagine. "Access is gradually opening up to Grok Heavy and Super Grok subscribers." TestingCatalog calls it "a shift from single-shot generation toward fully agentic creative work" and noted "no formal post from xAI yet". — [TestingCatalog](https://www.testingcatalog.com/xai-debuts-imagine-agent-in-grok-with-open-canvas-ai-workspace/)
- [SOCIAL; official-adjacent] Elon Musk retweeted @XFreeze: "Grok Imagine Agent Mode (Beta) just went live on Grok web It's a full creative agent working on one infinite open canvas…". Sources date this 2026-04-30 or 2026-05-01, probably a timezone difference. — [X/elonmusk](https://x.com/elonmusk/status/2049760093647024601)
- [SOCIAL] X post by Dogan Ural (xAI affiliation **not verified**): "Grok Imagine Agent Mode (beta) is here! - Brainstorm with agents on an infinite canvas - Create & edit multiple images at once - Turn images into videos & stitch them together - Trim, fade, crop, export, and more… Go to the web app". — [X/doganuraldesign](https://x.com/doganuraldesign/status/2049618903437910298)
- [3P-GUIDE] Codersera (published 2026-05-28, updated 2026-10-05) says there was "no formal press release and no x.ai blog post at launch". Steps to start: grok.com → Imagine → toggle Agent Mode → pick a template or type a free-form brief. Web only, with no iOS/Android Agent Mode. A paid plan is required (SuperGrok $30/mo or higher; SuperGrok Lite $10/mo excluded). Codersera itself flags its pricing as unattributed. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] Progressiverobot, 2026-09-05: the agent canvas is still web only, reached via grok.com/imagine/agent or an Agent Mode toggle in the Imagine input field. "xAI has not published an agent-specific tier page." — [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)

#### B. How the agent plans → generates → edits → stitches
- [PRESS] TestingCatalog, 2026-04-30: for "a 1-minute film" the agent drafts a scenario, generates individual scene clips, stitches them into a longer sequence and makes a companion poster image. Image tasks include multi-SKU product photoshoots, fusing several images into one composite, and building environments from existing visuals. A quoted tweet also lists "UGC product stories" and "a complete manga set". — [TestingCatalog](https://www.testingcatalog.com/xai-debuts-imagine-agent-in-grok-with-open-canvas-ai-workspace/)
- [SOCIAL] Wes Roth, about 2026-05-01: the agent generates "short films, comic book layouts, or cohesive product marketing packages from a single text prompt. The agent autonomously handles the multi-step process of generating, editing, and stitching the media together." — [X/WesRoth](https://x.com/WesRoth/status/2050576047939387568)
- [3P-GUIDE] Codersera: from one brief the agent breaks work into canvas steps: "plan," "generate variants," "select best," "image-to-video," "stitch," "export". Short Film produces a scene-by-scene treatment. Edits build on prior outputs, for example carrying a colour grade from scene 1 through the rest of the cut. Codersera also says the agent's planning runs on "the Grok 4.3 rate card" and that images come from "Aurora", but cites no source for either. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] Templates per Codersera:
  - **Create Worlds**: style-anchored sets of characters, locations and props.
  - **Short Film**: a multi-scene narrative from a logline.
  - **UGC Product Stories**: six "influencer holding the product" variations from one hero photo, plus a voiceover-ready edit.
  - **Brand Identity**: logo concepts, a palette, and 6–10 marketing visuals.
  — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] (snippet) The templates reportedly lay out 6–12 storyboard panels as keyframes, then stitch 6-second clips with auto-transitions. A guide suggests 30–60 s "mini films". — [BeginnersInAI](https://beginnersinai.org/grok-imagine-agent-mode-explained/); [AI Video Bootcamp](https://aivideobootcamp.com/blog/grok-imagine-complete-guide-2026/)
- [3P-GUIDE] Progressiverobot, 2026-09-05: the agent is "an orchestration layer over Grok Imagine's models". Canvas tools are Quick Animate, Group Images, Crop, Trim, Fade, Select/Hand and Stitch. Region editing uses Magic Wand and Segmentation and changes only the selected area. The agent inherits Image 2.0 Quality Mode tools (precision region editing, background removal, Smart Resize, up to five reference images). Image 2.0 became Quality Mode on 2026-08-07. — [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)
- [SOCIAL] A creator tutorial's topic list: "Generate bulk UGC content instantly, Turn images into full AI videos, Fix looping issues, Animate multiple scenes at once, Extend". — [X/MrMakiri](https://x.com/MrMakiri/status/2050104420432859304)

#### C. Lengths and resolution
- [3P-GUIDE] Codersera: each clip is 6 s at 720p, and "Agent Mode does not currently render true 1080p". There is no stated hard cap on film length; the FAQ says films practically run in the "30-second to several-minute range". Aspect ratios are 1:1, 16:9, 9:16, 4:3, 3:4, 3:2 and 2:3. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] Progressiverobot: launch-era limits from May 2026 third-party testing were 6 s, 720p and **no audio**. Video 1.5 brings native 1080p, character references and native audio, but this is "unconfirmed for the agent". No maximum sequence length is given for Stitch. — [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)
- [3P-GUIDE] (snippet) One guide warns "if you want a continuous 30-second shot, Agent Mode is not the tool yet". The search summary did not make clear which of these two pages it came from. — [BeginnersInAI](https://beginnersinai.org/grok-imagine-agent-mode-explained/) / [AI Video Bootcamp](https://aivideobootcamp.com/blog/grok-imagine-complete-guide-2026/)

#### D. Consistency and references (underlying model, official)
- [OFFICIAL] x.ai, "Imagine Video 1.5 with References", 2026-07-31:
  - "Our best video model, now with text, image, and voice references — generating up to 1080p."
  - Each reference image "locks one thing in place: a face, a product, a location." "Up to seven references per generation."
  - You can keep the character and swap the scene, or hold both and change only the action. With a character image plus a voice reference, "both hold": the same face and voice in every scene.
  - It builds on Imagine Video 1.5 from the previous month.
  — [x.ai news](https://x.ai/news/grok-imagine-video-1-5-references)
- [OFFICIAL] docs.x.ai video overview (accessed 2026-10-31): `grok-imagine-video-1.5` supports up to **14 reference images** (reference-to-video up to 15 s at 720p), up to **3 voice references**, first and last frame, and **up to 4 mid-video keyframes**. Reference images supply "characters, products, and locations without fixing the first frame". Custom voice references from your own audio are for trusted partners on request. **Conflict:** 7 refs in the July announcement vs 14 in current docs; the docs probably reflect a later increase. — [docs.x.ai overview](https://docs.x.ai/developers/model-capabilities/video/overview)
- [3P-GUIDE] Inside Agent Mode, Codersera found the only explicit consistency mechanism to be Create Worlds tying all assets to one style anchor, with "no character identity locking for video" described. Progressiverobot (2026-09-05) says drift is "partly addressed" by Video 1.5 character references and five-image conditioning for stills, and gives no quantified data. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/); [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)

#### E. Iteration and editing by prompt
- [3P-GUIDE] Codersera:
  - Click any node and reprompt that step alone, for example "redo scene 2 in golden-hour lighting".
  - Branch the tree to A/B test variations.
  - Drop reference images onto the canvas for later steps to use.
  - Export the video, the image set, or the full project.
  — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] Progressiverobot confirms per-node regeneration "without restarting the pipeline" and branching, based on third-party walkthroughs; xAI is not cited. — [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)
- [OFFICIAL] docs.x.ai:
  - **Video editing** (`POST /v1/videos/edits`) works only on `grok-imagine-video`. You send a clip plus an instruction; the model "applies the change and keeps the rest close to the source".
  - "The edited video retains the duration of the original, which is capped at 8.7 seconds." Custom duration, aspect ratio and resolution are not supported, and output is capped at 720p.
  - **Video extension** (`POST /v1/videos/extensions`) also works only on `grok-imagine-video`. The overview page says it "adds 2–10 s"; the generation page does not restate that range.
  — [docs.x.ai generation](https://docs.x.ai/developers/model-capabilities/video/generation); [docs.x.ai overview](https://docs.x.ai/developers/model-capabilities/video/overview)

#### F. API mechanics and latency (official)
- [OFFICIAL] docs.x.ai:
  - Flow: `POST /v1/videos/generations` → `request_id` → poll `GET /v1/videos/{request_id}` (`pending`/`done`/`failed`) → a `done` response has `video.url`, which is a temporary URL.
  - Parameters: `model`, `prompt`, `image`, `reference_images`, `reference_audios`, `last_frame`, `keyframes` (up to 4 `{image, timestamp_s}` on a 1/3-s grid), `duration` (1–15 s, default 8), `aspect_ratio` (default 16:9), `resolution` (480p default, 720p, 1080p), `generate_audio`.
  - Latency: generation "typically takes up to several minutes".
  - SDK polling defaults: AI SDK timeout 10 min with a 5 s interval; Python SDK timeout 10 min with a 1 s interval.
  — [docs.x.ai generation](https://docs.x.ai/developers/model-capabilities/video/generation)
- [OFFICIAL] The three models:
  - `grok-imagine-video-1.5`: native 1080p, lip-synced speech.
  - `grok-imagine-video-1.5-lite`: "lowest price per second"; 1080p upscaled from 720p.
  - `grok-imagine-video`: the only model with editing and extension; ≤720p.
  — [docs.x.ai overview](https://docs.x.ai/developers/model-capabilities/video/overview)
- [3P] Vercel AI Gateway lists the `grok-imagine-video-1.5` release date as **2026-06-22**. Billing is "per second of generated video" by resolution, with no figures shown. It notes "Generation can take minutes for longer or higher-resolution clips" and uses the model ID `spacexai/grok-imagine-video-1.5`. — [Vercel](https://vercel.com/ai-gateway/models/grok-imagine-video-1.5)
- [PRESS] Grok Imagine 1.0 was released on 2026-02-02, generating 720p videos up to 10 s. — [Gigazine](https://gigazine.net/gsc_news/en/20260203-grok-imagine-video-generation-ai)

#### G. "Extend from Frame" (consumer app)
- [SOCIAL; this is an AI-generated reply from the @grok chatbot account, not an xAI announcement] "The Extend button (Extend from Frame) in Grok Imagine shows up on the results screen after a full 10s video plays—tap the final frame to chain another clip." (about early March 2026) — [X/grok](https://x.com/grok/status/2028208032836899277)
- [SOCIAL] Creators say Extend from Frame chains clips to about 30 s total: "extend video clips up to 30 seconds". — [X/ajgodinho](https://x.com/ajgodinho/status/2044460996027195490); [X/junwatu](https://x.com/junwatu/status/2028090389018952155). A third-party blog title claims methods to go "past 30 seconds" (snippet). — [AtlasCloud](https://www.atlascloud.ai/blog/tips/grok-imagine-extend-video)

#### H. Pricing and access (mostly unofficial)
- [OFFICIAL] On 2026-07-31, references launched first in the US for SuperGrok Heavy and SuperGrok Plus on grok.com/imagine and iOS, rolling out to all tiers "over the next few days". Text-to-video and native 1080p are generally available on web, iOS and Android. API voice references are available "on request". — [x.ai news](https://x.ai/news/grok-imagine-video-1-5-references)
- [3P-GUIDE] Codersera (unsourced): SuperGrok is $30/mo or $300/yr with "pooled 200 generations per 24h across image and video". Heavy is $300/mo. API video is "about $4.20 per minute of output". Caps "changed multiple times in 2026". — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/)
- [3P-GUIDE] API image prices, which the article sources to xAI pricing: image-2.0 $0.04, image-quality $0.05 (retires 2026-11-02), image v1.0 $0.02. — [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/)

#### I. Grok Bot
- [OFFICIAL] x.ai "Introducing Grok Bot", 2026-08-11. — [x.ai news](https://x.ai/news/introducing-grok-bot)
  - **What it is:** "your team of always-on agents", launched in beta as "AI teammates you can give real work to". It began as an internal prototype that spread to sales outbound, marketing campaigns, office operations and bug fixes.
  - **How users talk to it:** you message a Bot "like a colleague" from phone or desktop and can pick up the same thread on either. No workflow or automation setup is needed.
  - **Bot-to-bot work:** Bots message each other, share context in threads and work in group chats. They "only come back when something needs your approval." You can show a Bot a task once and it saves it as a routine.
  - **Compute:** "Bots share a computer of their own in the cloud, so jobs do not stall when you step away."
  - **Availability:** SuperGrok, SuperGrok Plus and SuperGrok Heavy; Cursor Pro, Pro+ and Ultra; Cursor Teams Standard and Premium. Desktop and iOS. Bot usage is separate from Grok and Cursor plan limits. Enterprise has a waitlist. No Bot-specific price is listed, and the download buttons point to a cursor.sh domain.
  - **Video:** **The page never mentions Grok Imagine, video or media generation as a Bot capability.** "Marketing campaigns" appear only as a use case, with no media creation described.
- [PRESS] Unite.AI, written by an AI research agent and reviewed by editors: launched 2026-08-11. Included in SuperGrok Heavy, Cursor Ultra ($200/mo) and Cursor Teams Premium ($120/seat/mo). Android is "coming soon" and a Linux build exists. Imagine Image 2.0 is described as a separate release (2026-08-08), not connected to Grok Bot. Quote from xAI's Roman: "There is a huge difference between 90% done and 100% done." **Conflict:** Unite.AI's plan list is narrower than the current official page, which probably reflects expansion after launch. — [Unite.AI](https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/)
- [SOCIAL; via a Nitter mirror, date unknown] The @grok pinned post reads: "Introducing Grok Bot, now in early beta. Bots are AI teammates that do real work for you. They sign in to your tools… Grok Bot has expanded to more plans and is now free to try x.ai/bot". — [Nitter mirror](https://nitter-canary.kareem.one/grok)
- [3P] A search for Grok Bot together with Imagine or video returned only separate Grok Imagine coverage. Wikipedia lists Grok Bot simply as "AI teammates". — [Wikipedia: Grok](https://en.wikipedia.org/wiki/Grok_(chatbot))

### Inferences
- **Architecture clues (inferred):** an LLM planner (a Grok 4.x model) writes the scenario and shot plan. An image model produces keyframes and variants, and the user or agent selects. Video is generated per shot by image-to-video. Deterministic editor operations (Trim/Fade/Crop/Stitch, transitions) assemble the result, then it exports. Each stage is a canvas **node** that keeps its inputs, so it can be re-run alone or branched. That is effectively a DAG, not a chat transcript.
- **Keyframes-before-video** is xAI's main lever for product and character consistency. Stills are cheap to iterate, can carry the product reference, and are approved before the expensive image-to-video step.
- Each generated clip is short: about 6 s in the agent, 1–15 s in the API, and ≤8.7 s for editing. So any 15–60 s ad is **necessarily multi-shot**, and continuity comes from references, first/last-frame pinning, or extend-from-frame, not from one long generation.
- Prompt-based editing of generated video is lossy and short-clip-only: duration is kept, output is ≤720p, and "keep the rest close" is the best case. **Regenerating a whole shot remains the main edit primitive** for generative footage.
- Grok Bot is **not** a video-creation surface. It is useful as an **interaction model** for long-running jobs: persistent asynchronous teammates with their own computer, group chats of specialist bots, and a "come back only for approval" rhythm. A render pipeline that takes minutes to hours fits that pattern.

### Gaps
- No official xAI page or docs describe Agent Mode. Templates, the 6 s/720p cap, stitching limits and per-node editing come only from press and third-party sources. Whether Agent Mode now uses Video 1.5 (1080p, audio, references) is unconfirmed.
- I found no measured wait times for Agent Mode projects, and no documented maximum stitched-film length.
- Official per-second API video pricing was not retrieved; x.ai/pricing was not fetched, and the ~$4.20/min figure is unsourced.
- The official limit for Extend from Frame (30 s?) is unconfirmed. The @grok replies are generated by the chatbot.
- Not documented: whether a Grok Bot could drive grok.com/imagine through its cloud computer, and whether any creative or media Bot exists. No evidence was found either way beyond the launch page's silence.

---

## Q2. Anthropic: How do people get Opus 5.5 to produce promo/ad videos (prompting patterns, Remotion agent skills, HyperFrames, MCP connectors such as OpenArt/Pexo), and what are Claude Motion's scope and limits?

### Takeaway
Opus 5.5 (released 2026-09-22) has no video model. Anthropic's announcement never mentions video. The viral "Opus 5.5 videos" are **code**: in Claude Code the model writes HTML/Canvas/SVG/Three.js or Remotion/HyperFrames scenes whose frames are pure functions of time. A headless browser screenshots each frame and ffmpeg encodes the MP4. Quality comes from the harness rather than the one-line prompt:
- a brief, a timed shot list and approved stills before any code;
- real brand assets;
- house rules in CLAUDE.md or a SKILL.md;
- a self-critique loop where Opus reviews contact sheets of its own frames and re-renders only the affected seconds.

Photoreal shots are added through MCP connectors such as OpenArt (Seedance 2.5, Veo 3.1, Kling 3.0) or similar vendor skills. Claude Motion (beta 2026-10-08, Team/Enterprise) productizes the code-only path inside Claude: animated explainers built as editable code, MP4 export, and explicitly "no video generation model", so no realistic footage or people. Its length, resolution and audio limits are undocumented.

### Cited Findings

#### A. Opus 5.5, official facts (what Anthropic does and does not claim)
- [OFFICIAL] anthropic.com, 2026-09-22. — [Anthropic](https://www.anthropic.com/news/claude-opus-5-5)
  - Positioning: the first Claude 5.5 model, performing at Claude Fable 5.1 level on most work at 40% lower cost than Opus 5.
  - Pricing: $4 input / $20 output per million tokens. Fast mode (up to 2.5x speed) is $8/$40.
  - Model and settings: model ID `claude-opus-5-5`. "Thinking cannot be switched off."
  - Benchmarks: leads in agentic coding, computer use and knowledge work; OSWorld 2.1 81.8%.
  - Self-checking: it "checks its own work in creative ways", and "Self-verification loops feel easier to set up".
  - Long runs: it can work "autonomously for many hours"; one customer said it "stayed on task for over 18 hours".
  - Subscription five-hour usage limits are increasing.
  - **The page never mentions video, animation or motion graphics.** The closest visual claims are a game test won "on the strength of its graphics and polish" and denser slides.
- [VENDOR] OpenArt (October 2026): "Claude Opus 5.5 has no built-in image or video model." It cites Claude's Help Center saying Claude doesn't generate photos or illustrations the way image tools do. — [OpenArt blog](https://openart.ai/blog/how-to-generate-images-and-videos-with-claude-opus-5-5/)

#### B. The code-to-video pipeline (community-documented)
- [3P-GUIDE] opus5video.com, updated 2026-09-30. — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/)
  - An Opus 5.5 video "is not generated pixels". In Claude Code, Opus writes the animation as code (HTML, Canvas, Three.js or Remotion), renders it frame by frame in a headless browser, and encodes the frames to MP4 with ffmpeg.
  - "Every frame must be a pure function of time"; tell Claude this explicitly.
  - Use **Claude Code, not the chat app**. The chat app can preview animations as artifacts, but MP4 export needs a browser and ffmpeg.
  - Picking a route: Remotion for product videos, plain HTML for stylized motion design, Three.js for 3D.
  - Render time: a 30 s video at 30 fps is 900 frames, so "expect minutes, not seconds".
- [3P-GUIDE] The same guide's 6-step workflow:
  1. Set up in an empty folder, or inside the product's repo so Claude can reuse real components, icons and copy.
  2. Write a brief: length, aspect ratio, audience, platform, URL and assets, one style reference, and what not to do.
  3. **Approve a timed shot list** ("0–3 s hook, 3–6 s name reveal…") **and one still per shot**: "takes a minute and saves a lot of re-rendering".
  4. Animate: spring easing with a small overshoot, one idea per shot, a short line on screen for at least 1.2 s, a transition at every cut, varied rhythm.
  5. Render a few sample frames first, then the whole video.
  6. Have Claude build a contact sheet (first and last frames, frames around every cut) and critique it "like a senior motion designer", then fix and re-render.

  It quotes a Reddit comment: "one-shot prompts are a lottery, the loop is a process". — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/)
- [3P-GUIDE] Audio: "Generate the voice first, measure each sentence, then time the shots to it." Tell Claude the music BPM so cuts land on the beat. Keep TTS API keys in `.env`. — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/)
- [3P-GUIDE] Mistakes that look "cheap":
  - invented UI (use real screenshots);
  - more than 8 words on screen;
  - AI tells such as corner labels, frame borders, fake timecodes or "SYSTEM ONLINE";
  - one uniform speed;
  - a blank first frame or an abrupt last frame (hold the end about 2 s);
  - skipping the review pass.
  — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/)

#### C. Prompting patterns and harness (Movez "motion design studio" course, 2026-10-04)
- [3P-GUIDE] Thesis: "the prompt is 10% of the video" and the rest is the harness. The render contract is a `window.seek(t)` or `draw(t)` function with no `Math.random`, timers, CSS transitions or carried state; use seeded noise instead. — [Movez Substack](https://movez.substack.com/p/how-to-build-motion-design-studio)
- [3P-GUIDE] **CLAUDE.md house rules**, read on every run:
  - the render contract;
  - banned defaults: centered title on a gradient, everything fading in, corner labels, glow on UI chrome;
  - one accent colour and a new event every 2–4 s;
  - synthesized sound on the beat grid at -14 LUFS;
  - the critique loop.

  Supporting files: `docs/style_guide.md`, `docs/shotlist.md`, `docs/STORYBOARD.md`, `docs/review_log.md`, and folders `refs/`, `assets/`, `audio/`. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)
- [3P-GUIDE] Prompt archetypes. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)
  1. **One-liner showreel**: tests the engine, but outputs from different users look alike.
  2. **Brand prompt**: give the product URL. Opus visits the site, saves assets to `./assets`, lists them before animating, and must "never redraw the product UI from imagination". Beat structure: hook → product reveal → three features → a metric → logo + CTA. Render 1080x1920 first, then other ratios from the same timeline.
  3. **Reference prompt**: extract frames with ffmpeg, then write `style_guide.md` and `shotlist.md`. The reference supplies grammar (pacing, type, transitions), never content. **Wait for approval before code.**
  4. **XML spec prompt** with `<inputs>`, `<direction>`, `<structure>`, `<build>`, `<gotchas>` and `<start>`.
  5. **Director's brief**: logline, references, tools and API keys with a budget, a character bible, a beat sheet, text rules, and gates (plan → rig → stills → animatic → full pass → polish → audio → render). Opus may proceed after 10 min without a reply, so the gates do not strictly block.
  6. **A packaged `SKILL.md`** (`motion-reel`) that triggers the whole pipeline from one sentence.
- [3P-GUIDE] **Critique loop.** — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)
  - Opus views its own frames as contact sheets (ffmpeg `tile`) and 360 px phone previews.
  - It scores 1–10 on: hook in the first 2 s, readability at phone size, motion quality, variety, composition, brand accuracy and sound sync.
  - It lists the **three worst problems with timestamps**, fixes them, and **"re-renders only the affected seconds"**, repeating until every score is ≥8, with at least 3 rounds.
  - Determinism check: render twice and compare MD5 hashes.
- [3P-GUIDE] Render and audio. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)
  - Render with `node render.mjs --fps 60 --dur 15 --sub 4`, which blends 4 subframes per frame for motion blur. Encode H.264 yuv420p at CRF 16.
  - `beats.py` uses librosa to detect beats in a supplied track, and `sfx.mjs` synthesizes clicks and whooshes.
  - Effort via `/model`: medium for small fixes, xhigh for new films, max for flagship pieces.
- [3P-GUIDE] **Frameworks are skipped unless named.** Opus "tends to skip [Remotion/HyperFrames] by default and writes its own engine unless you request one" (Movez). This is corroborated (snippet): "It skipped Remotion and HyperFrames even when available. If you want a framework, say so explicitly." — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio); [Skillry](https://skillry.dev/ai-videos/opus-5-5); [Ciyo](https://ciyo.ai/blog/opus-5-5-video-motion-graphics-guide)
- [3P-GUIDE] **Hybrid with a video model, "generate-then-trace":** Seedance 2.5 renders base shots, then Opus redraws the video in JavaScript on top. Keys such as ElevenLabs and FAL go in `.env`, never in prompts. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)

#### D. Frameworks: Remotion agent skills and HyperFrames
- [OFFICIAL] Remotion. — [Remotion docs: AI skills](https://www.remotion.dev/docs/ai/skills)
  - Install with `npx skills add remotion-dev/skills` or `gh skill install remotion-dev/skills`; skills are also offered during `bun create video`.
  - Listed agents: Claude Code, Codex, Kimi Code, Cursor.
  - Skills: `/remotion-best-practices`, `/remotion-create`, `/remotion-markup`, `/remotion-studio`, `/remotion-render`, `/remotion-maps`, `/remotion-captions`, `/remotion-saas`, `/remotion-interactivity`, `/remotion-docs`, `/remotion-license` (v4.0.540+), `/remotion-upgrade`, `/remotion-multimedia`.
  - Example prompt: `/remotion-create Make a promo video for a record store`.
- [OFFICIAL] (snippet) The Remotion CLI also has `npx remotion skills` to install or update. Skills go into `.agents/skills`, and Claude Code compatibility comes from symlinking `.claude/skills`. — [Remotion CLI skills](https://www.remotion.dev/docs/cli/skills)
- [OFFICIAL] HyperFrames (HeyGen, Apache 2.0). — [GitHub heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)
  - Turns HTML/CSS/media/seekable animations into **deterministic** MP4: "same input, same frames, same output". It seeks each frame in headless Chrome and encodes with FFmpeg.
  - Animation libraries: GSAP, CSS, Lottie, Three.js, Anime.js, WAAPI, or a custom frame adapter.
  - Its skills walk the agent through planning, writing HTML, wiring animations, adding media, linting, previewing and rendering.
  - Commands: `npx skills add heygen-com/hyperframes`, `npx hyperframes init my-video`, `npx hyperframes preview`, `npx hyperframes render`.
  - Claude Code plugin: `claude plugin marketplace add heygen-com/hyperframes`, then `claude plugin install hyperframes@hyperframes`.
  - Skills: `/hyperframes`, `/hyperframes-cli`, `/hyperframes-registry` and `/media-use`; `/figma`, `/slideshow` and `/remotion-to-hyperframes` install on demand.
  - Extras: Studio browser editor, Lambda distributed rendering. Requires Node 22+ and FFmpeg.
  - Comparison with Remotion: plain HTML with no build step vs React plus a bundler; Apache 2.0 vs Remotion's source-available license.
- [3P] (snippet) HyperFrames was open-sourced in April 2026. — [Noqta](https://noqta.tn/en/blog/heygen-hyperframes-html-to-mp4-ai-agent-video-2026)

#### E. Adding photoreal/generative shots via MCP connectors and skills
- [VENDOR] OpenArt (October 2026). — [OpenArt blog](https://openart.ai/blog/how-to-generate-images-and-videos-with-claude-opus-5-5/)
  - **Setup:** add a custom connector at `https://mcp.openart.ai/mcp` (Customize → Connectors → + Add → Add custom connector) and sign in. No API key is needed. On Team/Enterprise an admin adds it first.
  - **How Claude uses it:** Opus "expands each one into a detailed prompt" and picks a model, or uses the one you name.
  - **Ad-style example prompt:** "Plan a 15-second TikTok ad for a reusable water bottle in 3 shots. **Show me the shot list first, then generate shot 1** with Seedance 2.5 Draft." "Asking for the shot list first lets you fix the plan before you spend credits on video."
  - **Seedance 2.5 Draft:** a 480p preview. You can generate native 1080p within 7 days; the 1080p version "keeps the overall composition and movement, but it won't be identical frame for frame".
  - **Model specs (vendor-stated):** Seedance 2.5 clips run "up to 30 seconds with synced audio". Gemini Omni 1.1 Flash and Veo 3.1 have native audio "up to 4K".
  - **Cost and plans:** "You can ask Claude what a generation will cost before it runs." MCP is included from Starter ($14/mo); commercial use starts at Plus ($34/mo).
  - **Suggested split:** "plan in Claude and finish edits on the website."
- [VENDOR] (snippet) The OpenArt connector page lists Seedance 2.5 / 2.5 Draft / 2.0, Veo 3.1, Kling 3.0, Wan 3.0, MiniMax H3 Max, Gemini Omni 1.1 Flash and PixVerse V6. Clips cost from about 50 credits (PixVerse V6) to a few hundred. A 30 s Seedance 2.5 scene at 480p is about 1,810 credits (as of October 2026). — [OpenArt MCP page](https://openart.ai/mcp/claude-ai-video-generator/)
- [VENDOR] (snippet) Pexo installs as a skill (SKILL.md) in Claude Code and "returns a finished video", routing across 10+ models including Kling 3.0, Seedance 2.0 and Veo 3.1. These are self-promotional claims. — [Pexo blog](https://pexo.ai/blog/can-claude-code-make-videos-5767)

#### F. Reported time, cost and reach (self-reported, unverified)
- [SOCIAL via 3P-GUIDE] — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/)
  - A 26 s startup launch video from a one-line prompt took about 1 minute and about $2 (@deedydas).
  - A video "made entirely with Opus 5.5" cost $3.21 of OpenRouter usage (r/ClaudeAI).
  - A 3-minute Remotion explainer took about 1 hour (@kimmonismus).
  - An interactive explainer took 1 h 26 min and $25.66 (@RyanSael).
  - Creators hit their 5-hour subscription limits "after a couple of big prompts".
  - Sonnet 5.5 is reportedly close in quality at lower cost.
- [SOCIAL via 3P-GUIDE] — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio)
  - Product reels took about 15 min and under 30 min; a 38 s vertical film took about 45 min.
  - A 142 s music video came from a 5-minute spoken brief plus about 12 hours of autonomous work.
  - A watercolor short used 163 model calls over about 6¾ h.
  - A prior agency-made launch video reportedly cost $1,000+.
- [SOCIAL via 3P-GUIDE] (snippet) The opus5video examples page lists 36 clips at about 11K to 487K views on X. The 487K-view clip is an 11 s dark SaaS UI sequence (HyperFrames or Remotion), with a method of: start from a reference video, use real UI components, approve stills before motion, give director-style notes. A 58 s product launch (151K views) was made with HyperFrames in "under 20 minutes". — [opus5video examples](https://opus5video.com/examples/)
- [3P-GUIDE] Limitation: "motion graphics, not photorealistic footage". Photoreal scenes and organic movement still need real footage or a video model. — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/); [Skillry](https://skillry.dev/ai-videos/opus-5-5) (snippet)

#### G. Claude Motion (official)
- [OFFICIAL] @claudeai, 2026-10-08: "Claude Motion turns reports, charts, or product walkthroughs into short animations. Claude writes each one as code, with no video model involved, so you can change any word, number, or timing, then export an MP4. In beta on Team and Enterprise plans." — [X/claudeai](https://x.com/claudeai/status/2108271558170976743)
- [OFFICIAL] Help Center, "Get started with Claude Motion". — [Claude Help Center](https://support.claude.com/en/articles/17454997-get-started-with-claude-motion)
  - **Availability:** beta on Team (on by default) and Enterprise (off until an owner enables it under Organization settings > Artifacts; custom roles can limit it to specific groups).
  - **Creating:** ask in any chat, or choose "Output" → "Motion", or pick a Motion template from the Artifacts tab.
  - **Tips:** state the audience, where it will play, and roughly how long it should be; attach reports, data or images.
  - **No video model:** it "doesn't use a video generation model", so no realistic footage or people. You can change one detail (word, number, timing) and leave the rest unchanged.
  - **Editing:** via chat or "directly in the editor".
  - **Export and sharing:** Export → MP4 (no other format is mentioned). Animations are private by default, with a Share option.
  - **Usage:** counts toward plan limits, and "longer or more complex animations use more".
- [OFFICIAL] claude.com resources, "Dashboards and Motion". — [Claude resources](https://claude.com/resources/articles/dashboards-and-motion)
  - Example uses: a 30-second all-hands explainer from a quarterly report, motion added to a chart in a board deck, and a product walkthrough for customer onboarding. The output "plays like a short video".
  - Canva and Captions integrations are "coming soon". The page lists other integrations available now, including Adobe, Descript, HeyGen, Higgsfield, invideo, Luma AI and Runway; it is unclear which apply specifically to Motion.
  - **No length or resolution limits are stated.**
- [PRESS] TestingCatalog, 2026-10-08. — [TestingCatalog](https://www.testingcatalog.com/claude-launches-dashboards-and-motion-in-beta/)
  - Motion launched together with Dashboards (beta, paid plans).
  - Docs, Slides and Design left beta on all plans, including Free. Anthropic says more than 45M docs, decks and designs have been created.
  - Standalone Claude Design is being folded into Claude, and the standalone site stays up until December 14.
  - Docs, Slides and Design become default-on for Enterprise on October 15.
- [3P-GUIDE] (snippet) Pro and Max plans don't have Motion. — [Createmotion](https://createmotion.io/guides/claude-motion-explained/)

### Inferences
- Anthropic's own products separate **code-rendered motion** from **generative footage**. Motion gives exact, editable text, numbers and timing with no people or footage. Generative footage is left to partner tools and connectors (Runway, Luma, HeyGen, Higgsfield, or OpenArt/Seedance via MCP). The viral Opus 5.5 workflow is the same split done by hand in Claude Code, plus frame-level self-review.
- For an Agent SDK ad agent, the field-tested stack has five parts:
  1. Claude as planner, director and critic.
  2. A deterministic code compositor (Remotion or HyperFrames, both installable as agent skills) for typography, logo, price, CTA, captions and real product UI.
  3. External video model calls (API or MCP) for photoreal shots.
  4. ffmpeg for stitching and the audio mix.
  5. A vision-based review pass on contact sheets.
- Opus will improvise its own renderer unless told otherwise. The agent's system prompt or skills should **pin the framework, the render contract (`seek(t)`, no randomness), the banned "AI tells", and the approval gates**, as in a CLAUDE.md or SKILL.md.
- Iteration dominates cost and time. Token costs per video are reported at about $2–$26, while generative clips are billed separately (about 1,810 OpenArt credits for one 30 s Seedance 480p scene). So cheap planning and stills, then drafts, then final renders is the right economic order.

### Gaps
- I found no official Anthropic statement about Opus 5.5 making video. View counts, timings and costs are creators' self-reports collected by third-party sites.
- Claude Motion's maximum duration, resolution, aspect ratios, fps, audio/voiceover support and underlying engine are not documented in what I found. The claim that Pro/Max are excluded is third-party.
- I found no official Anthropic connector for video models. OpenArt and Pexo claims, including model lists and credit prices, are vendor marketing.
- Two long-form X "course" articles could not be read (X article pages): "How to Use Opus 5.5 as Your Marketing Video Director" — [X/neil_xbt](https://x.com/neil_xbt/article/2103862582041874854); the Movez course was read via its [Substack mirror](https://movez.substack.com/p/how-to-build-motion-design-studio).

---

## Q3. Google and OpenAI (brief): do they have agent-style multi-shot workflows?

### Takeaway
Google has one. At I/O on 2026-05-19, Google launched a **Flow Agent** that plans multi-step tasks "under your control", generates variations and batch-edits project assets. It runs alongside **Gemini Omni Flash**, a model that edits video through conversation and preserves "identity and voice… across every scene". Third-party guides add Scenebuilder/timeline multi-shot features (about 60 s sequences, 4–10 s clips), but these are unconfirmed. OpenAI has **no first-party video product as of 2026-10-31**: it announced the end of Sora on 2026-03-24, closed the app on 2026-04-26, and discontinued the API on 2026-09-24. Sora 2's storyboard (multi-shot in one generation) is now only a historical reference.

### Cited Findings
- [OFFICIAL] Google blog, 2026-05-19. — [blog.google Flow updates](https://blog.google/innovation-and-ai/models-and-research/google-labs/flow-updates/)
  - **Gemini Omni Flash:** "can create anything from any input, starting with video". It can blend real-world footage with generated content and "iterate through conversation", and "identity and voice are preserved across every scene". Available in Flow for Google AI subscribers globally.
  - **Flow Agent:** can "plan and reason through complex tasks with your inputs, under your control", create multiple variations at once, apply tweaks across all of a project's assets, and sort and rename assets into collections. Available to all Flow users globally.
  - **Flow Tools:** custom tools described in natural language, shareable and remixable.
  - **Apps and reach:** Flow app on Android in beta (18+), with iOS coming; Flow is in 140+ countries.
- [PRESS] FoneArena, 2026-05-20, quoting Google: "an agent for every step of the creative process" and Omni is "Nano Banana, but for video". Flow Agent can act as a sounding board for character dialogue and suggest plot developments. Omni Flash enables conversational direction of music videos. — [FoneArena](https://www.fonearena.com/blog/483182/google-i-o-2026-google-flow-music-gemini-omni-ai-agents-mobile-apps.html)
- [3P-GUIDE] (snippet; low reliability) — [AI Flow Matrix](https://aiflowmatrix.com/google-flow-explained/); [SaaSCRMReview](https://saascrmreview.com/google-flow-review/)
  - **Scenebuilder** extends shots while keeping characters and setting consistent.
  - The timeline arranges multi-shot sequences up to about 60 s.
  - Clips are 4, 6 or 8 s on Veo and up to 10 s on Omni Flash. Veo 3.1 Lite, Fast and Quality remain in the picker.
  - Credits: Lite 10, Fast 20, Quality 100; Omni Flash from 4.
  - Sources disagree on whether "Veo 4" exists.
- [OFFICIAL, via Wikipedia citing OpenAI's Help Center] — [Wikipedia: Sora](https://en.wikipedia.org/wiki/Sora_(text-to-video_model)); [OpenAI Help Center (archived)](https://web.archive.org/web/20260630192218/https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation)
  - Sora 2 and its iOS app launched 2025-09-30 with social and "cameo" features; Android followed about November 2025; Disney signed a $1B, 3-year licensing deal on 2025-12-11.
  - On **2026-03-24** OpenAI announced on X that it was discontinuing Sora in the app and API.
  - The **app shut down 2026-04-26** and the **API was discontinued 2026-09-24**.
  - OpenAI's notice "did not provide a specific reason".
- [PRESS] Reported reasons: compute shortages, cost pressure and an enterprise pivot. Users peaked near 1M, then fell below 500K, and the service cost an estimated "$1 million per day to operate". — [TechCrunch 2026-03-29](https://techcrunch.com/2026/03/29/why-openai-really-shut-down-sora/), as cited on [Wikipedia](https://en.wikipedia.org/wiki/Sora_(text-to-video_model))
- [3P-GUIDE] (snippet; historical) Sora 2 Storyboard was a multi-shot editor with per-scene prompts, timing and transitions "in a single generation". A hands-on called it "rudimentary". — [UD Insight (2026-06-02)](https://www.ud.com.hk/en/blogs/insight/article/2026-06-02-sora-2-storyboard-mode); [DEV Community](https://dev.to/guang_diyuzhi_74b0fec2c09/sora-in-2026-hands-on-with-openais-video-generator-2ek7)
- [PRESS] (snippet) Reports conflict on whether ChatGPT keeps any video generation. Image creation and editing in ChatGPT were reported as unaffected. — [PC Gamer](https://www.pcgamer.com/software/ai/openai-discontinues-sora-video-generation-app-disney-pulls-out-of-usd1-billion-investment-deal)

### Inferences
- Google puts **consistency into the model** (Omni preserves identity and voice) and **planning and batch edits into the agent**, with the timeline/Scenebuilder as the multi-shot assembly layer. This is the same planner/generator/editor/stitcher split as Grok's canvas.
- The Sora shutdown, with costs estimated at about $1M/day, is a reminder that generative video compute is expensive. A production agent should use drafts and previews, cap regenerations, and show cost before generating.

### Gaps
- No official Google description of Flow Agent's multi-shot planning, maximum lengths, or how edits propagate across shots. Scenebuilder and timeline details are third-party only.
- Whether ChatGPT offers any video generation as of 2026-10-31 is unresolved; I found no OpenAI page confirming either way.

---

## Q4. What do these products reveal about how a conversational video agent should iterate (partial regeneration vs full re-render, previews/drafts first, how long the user waits)?

### Takeaway
Every lab product and serious community workflow converges on the same order: **plan and approve, cheap stills or drafts, then per-shot generation, assembly, a self or user review, and targeted fixes**. Edits happen at the **smallest unit that can be redone**: a canvas node or scene in Grok Agent Mode, a single word, number or timing in Claude Motion, "only the affected seconds" in Opus code renders, and a whole shot for generative clips because prompt-editing is limited to ≤8.7 s at ≤720p. Waits run from minutes per generated clip (xAI: "up to several minutes") to minutes per code render, and from about 15 minutes to many hours for a polished piece. Long jobs therefore need to be asynchronous, with progress updates and approval checkpoints, as Grok Bot does by "only coming back when something needs your approval".

### Cited Findings

#### Plan and approve before spending
- Grok Agent Mode runs plan → generate variants → select best → image-to-video → stitch → export. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/) [3P-GUIDE]
- "Show me the shot list first, then generate shot 1… Asking for the shot list first lets you fix the plan before you spend credits on video." — [OpenArt](https://openart.ai/blog/how-to-generate-images-and-videos-with-claude-opus-5-5/) [VENDOR]
- A timed shot list plus one still per shot, approved before animating: "takes a minute and saves a lot of re-rendering". — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/) [3P-GUIDE]
- Gates run plan → rig → stills → animatic → full pass → polish → audio → render, with auto-proceed after 10 min of silence. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio) [3P-GUIDE]
- Claude Motion asks for the audience, where it will play and the length up front, plus attached source data. — [Claude Help Center](https://support.claude.com/en/articles/17454997-get-started-with-claude-motion) [OFFICIAL]
- Flow Agent plans "with your inputs, under your control". — [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/flow-updates/) [OFFICIAL]

#### Drafts and previews first
- Seedance 2.5 Draft gives a 480p preview, then a 1080p regeneration within 7 days that is "not identical frame for frame". — [OpenArt](https://openart.ai/blog/how-to-generate-images-and-videos-with-claude-opus-5-5/) [VENDOR]
- xAI's API defaults to **480p**, and `-lite` is the cheapest per second. — [docs.x.ai](https://docs.x.ai/developers/model-capabilities/video/generation) [OFFICIAL]
- Code-video practitioners render sample frames before the full render, and use contact sheets and 360 px phone previews. — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/); [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio) [3P-GUIDE]
- Grok Agent Mode makes keyframe images and variants before image-to-video. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/); [TestingCatalog](https://www.testingcatalog.com/xai-debuts-imagine-agent-in-grok-with-open-canvas-ai-workspace/)

#### Partial regeneration vs full re-render
- Grok Agent Mode lets you reprompt one node ("redo scene 2 in golden-hour lighting") and branch for A/B tests. — [Codersera](https://codersera.com/blog/grok-imagine-agent-mode-launch-2026/); [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/) [3P-GUIDE]
- Claude Motion: "change a single detail, such as a word, number, or timing, and leave the rest unchanged". — [Claude Help Center](https://support.claude.com/en/articles/17454997-get-started-with-claude-motion) [OFFICIAL]
- The Opus critique loop fixes the 3 worst problems by timestamp and "re-renders only the affected seconds". — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio) [3P-GUIDE]
- xAI's edit endpoint keeps the source duration (≤8.7 s) and outputs ≤720p, and extension adds 2–10 s. Edits work at the shot level, not the film level. — [docs.x.ai](https://docs.x.ai/developers/model-capabilities/video/overview) [OFFICIAL]
- Flow Agent batch-applies tweaks across all of a project's assets. — [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/flow-updates/) [OFFICIAL]

#### How long the user waits
- xAI API generation "typically takes up to several minutes", with a 10-min default SDK poll timeout. — [docs.x.ai](https://docs.x.ai/developers/model-capabilities/video/generation) [OFFICIAL]
- "Generation can take minutes for longer or higher-resolution clips." — [Vercel](https://vercel.com/ai-gateway/models/grok-imagine-video-1.5) [3P]
- Code render: a 30 s video at 30 fps is 900 frames, "minutes, not seconds". Whole pieces took about 1 min (26 s one-shot), about 1 h (3-min explainer), and 1 h 26 min (interactive explainer). — [opus5video](https://opus5video.com/how-to-make-videos-with-claude/) [SOCIAL via 3P]
- Polished reels took 15–45 min. A 142 s music video took about 12 h autonomously, and a short used 163 model calls over about 6¾ h. — [Movez](https://movez.substack.com/p/how-to-build-motion-design-studio) [SOCIAL via 3P]
- Grok Bot jobs keep running on the bot's own cloud computer when you step away, and bots return only for approvals. — [x.ai](https://x.ai/news/introducing-grok-bot) [OFFICIAL]

#### Key dates timeline
| Date | Event | Source |
|---|---|---|
| 2025-09-30 | Sora 2 and iOS app launched | [Wikipedia](https://en.wikipedia.org/wiki/Sora_(text-to-video_model)) |
| 2026-02-02 | Grok Imagine 1.0 (720p, ≤10 s) | [Gigazine](https://gigazine.net/gsc_news/en/20260203-grok-imagine-video-generation-ai) |
| ~2026-02-28 to early March | "Extend from Frame" appears in Grok Imagine (social posts) | [X/junwatu](https://x.com/junwatu/status/2028090389018952155) |
| 2026-03-24 | OpenAI announces Sora discontinuation | [Wikipedia](https://en.wikipedia.org/wiki/Sora_(text-to-video_model)) |
| 2026-04 | HyperFrames open-sourced (snippet) | [Noqta](https://noqta.tn/en/blog/heygen-hyperframes-html-to-mp4-ai-agent-video-2026) |
| 2026-04-26 | Sora app shut down | [Wikipedia](https://en.wikipedia.org/wiki/Sora_(text-to-video_model)) |
| 2026-04-30 / 05-01 | Grok Imagine Agent Mode beta on Grok web | [TestingCatalog](https://www.testingcatalog.com/xai-debuts-imagine-agent-in-grok-with-open-canvas-ai-workspace/) |
| 2026-05-19 | Google I/O: Gemini Omni Flash and Flow Agent | [blog.google](https://blog.google/innovation-and-ai/models-and-research/google-labs/flow-updates/) |
| 2026-06-22 | Grok Imagine Video 1.5 release (Vercel listing) | [Vercel](https://vercel.com/ai-gateway/models/grok-imagine-video-1.5) |
| 2026-07-31 | "Imagine Video 1.5 with References" (image and voice refs, 1080p) | [x.ai](https://x.ai/news/grok-imagine-video-1-5-references) |
| 2026-08-07 | Imagine Image 2.0 as Quality Mode (3P) | [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/) |
| 2026-08-11 | Grok Bot early beta | [x.ai](https://x.ai/news/introducing-grok-bot) |
| 2026-09-22 | Claude Opus 5.5 | [Anthropic](https://www.anthropic.com/news/claude-opus-5-5) |
| 2026-09-24 | Sora API discontinued | [Wikipedia](https://en.wikipedia.org/wiki/Sora_(text-to-video_model)) |
| 2026-10-08 | Claude Motion beta (Team/Enterprise) and Dashboards; Docs/Slides/Design GA | [X/claudeai](https://x.com/claudeai/status/2108271558170976743); [TestingCatalog](https://www.testingcatalog.com/claude-launches-dashboards-and-motion-in-beta/) |
| 2026-11-02 (scheduled) | `grok-imagine-image-quality` slug retires | [Progressiverobot](https://www.progressiverobot.com/2026/09/05/grok-imagine-agent-image-2-0-model-update/) |

### Inferences
These are design implications for a Claude Agent SDK ad-video agent, inferred from the findings above.
1. **Keep the ad as a structured, versioned timeline or shot graph, not just chat history.** The graph runs brief → script/VO → shot list with second-level timings → per-shot keyframes → per-shot clips → code overlays (text, price, logo, CTA, captions) → audio → final. Each user edit marks specific nodes as dirty. Regenerate only those, then re-stitch, which is cheap with ffmpeg. This mirrors Grok's node canvas, Motion's single-detail edits and Movez's "affected seconds" re-render.
2. **Use two render paths and route by shot type.** Generative clips (Seedance, Grok Imagine, Veo, Kling; 4–15 s each, Seedance up to 30 s) cover photoreal product-in-use and people shots. Deterministic code (Remotion or HyperFrames skills) covers anything that must be exact and instantly editable: claims, prices, logos, end cards, UI. This is the reason Claude Motion avoids a video model.
3. **Make the gates explicit and cheap.** Confirm the brief, then approve script and shot list (text only), then keyframe stills with product and character references locked, then low-res draft clips (480p or Draft or lite), then final 1080p, then polish and audio. Offer an auto-proceed timeout for power users, as in Movez's 10 minutes.
4. **Treat consistency as data.** Pass the same product, character and voice references on every shot call (xAI allows up to 7 or 14 refs and 3 voices). Pin first and last frames, or use extend-from-frame, at shot boundaries. Keep a "style anchor" or brand doc, like Create Worlds or CLAUDE.md, in context.
5. **Close the loop with vision.** After each render, extract a contact sheet and have Claude score it against the brief and brand rubric (hook in 2 s, readability at phone size, brand accuracy, sync). Fix the worst issues by timestamp before showing the user.
6. **Make waiting asynchronous.** Submit per-shot jobs in parallel and poll (xAI uses the request_id pattern with a 10-min timeout). Stream progress and post stills and drafts into the chat as they land. Expect minutes per clip and about 15–60 minutes for a polished 15–60 s ad. Only ping the user at gates, in the Grok Bot style.
7. **Show cost before generating.** OpenArt lets Claude quote credits before a run. Cap regenerations per shot, and prefer lite or draft tiers while exploring, given video's cost profile (Sora's estimated $1M/day).
8. **Determinism enables partial re-render.** Code scenes must be pure functions of time (`seek(t)`, seeded randomness, MD5-checked renders). Record seeds and model versions for generated shots so you can tell when a re-run will drift.
9. **Pair chat with a visual handle.** Grok's canvas, Motion's direct editor and HyperFrames/Remotion Studio all show that "change shot 3" works better when the user can point at a shot or timecode. A chat-only agent should at least number shots and show a storyboard or contact sheet each turn.

### Gaps
- No lab has published how it implements partial re-render internally, or measured user wait times for Agent Mode or Claude Motion. The wait figures above come from API docs and creator self-reports.
- No data was found on typical regenerations per shot, or on cost per finished 15–30 s ad for any first-party product.
