# Seedance (ByteDance) video generation models & API, plus comparison with other video APIs (as of 2026-10-31)

> Scope: what an engineer needs to wire Seedance into an agent that produces ~30 s ad videos. Official docs were read directly where possible: the Volcengine Ark (火山方舟) create/get task API pages and video tutorial, and the BytePlus ModelArk create-task page. Official pricing pages (Volcengine 模型价格, BytePlus Pricing) render via JavaScript and could NOT be read, so all prices below come from secondary sources and are flagged as such. Items marked **[unverified]** were not confirmed in official docs.

## 1. Which Seedance model versions exist and are current? Exact model IDs

### Takeaway
Current API models (Oct 2026) are **Seedance 2.5** (flagship; 4–30 s; up to 1080p; audio+video), the **Seedance 2.0 series** (2.0 / 2.0 fast / 2.0 mini; 4–15 s), the legacy **Seedance 1.0 pro / 1.0 pro fast** (silent; 2–12 s), and **Seedance 1.5 pro**, which is still listed on BytePlus but missing from the current Volcengine docs. Volcengine (China) IDs start with `doubao-seedance-…`. BytePlus (international) IDs for 2.x start with `dreamina-seedance-…`, and for 1.x with `seedance-…`. An enterprise-only "Seedance 2.5 4K" was reported around 2026-10-26, with no public model ID.

### Cited Findings
- Official Volcengine capability table (fetched 2026-10-31) lists exactly six models and their IDs: Seedance 2.5 = `doubao-seedance-2-5-260628`; Seedance 2.0 = `doubao-seedance-2-0-260128`; 2.0 fast = `doubao-seedance-2-0-fast-260128`; 2.0 mini = `doubao-seedance-2-0-mini-260615`; 1.0 pro = `doubao-seedance-1-0-pro-250528`; 1.0 pro fast = `doubao-seedance-1-0-pro-fast-251015` — [Volcengine 视频生成教程](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- The Volcengine create-task page (last updated 2026-10-28) says "Seedance 2.5 已全面公开". Its capability list covers only Seedance 2.5, the 2.0 series, 1.0 pro and 1.0 pro fast, with no Seedance 1.5 pro — [Volcengine 创建视频生成任务](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- An older Volcengine model-list snapshot (page dated 2026-05-29) still listed `doubao-seedance-1-5-pro-251215` (音画同生, 480p/720p/1080p, 24 fps, 4–12 s), next to `doubao-seedance-2-0-260128`, `doubao-seedance-2-0-fast-260128`, `doubao-seedance-1-0-pro-250528` and `doubao-seedance-1-0-pro-fast-251015` — [Volcengine 模型列表 (snapshot)](https://www.volcengine.com/docs/82379/1330310)
- BytePlus ModelArk (international) create-task page: "Dreamina Seedance 2.5 is now fully available". It lists the capabilities of Dreamina Seedance 2.5, the Dreamina Seedance 2.0 series (2.0 / 2.0 fast / 2.0 mini), **Seedance 1.5 pro** (video with audio / silent), Seedance 1.0 pro and Seedance 1.0 pro fast. Official example IDs on that page are `dreamina-seedance-2-5-260628` and `seedance-1-5-pro-251215` — [BytePlus Create a video generation task](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- BytePlus 2.0 IDs from secondary sources: `dreamina-seedance-2-0-260128` ([DataCamp tutorial](https://www.datacamp.com/tutorial/seedance-2-0-api-guide)), `dreamina-seedance-2-0-fast-260128` ([PyPI byteplus-py example](https://pypi.org/project/byteplus-py/)) and `dreamina-seedance-2-0-mini-260615` ([WaveSpeed guide](https://wavespeed.ai/blog/ai-api-pricing/seedance-2-0-mini-api-guide/)) — **[unverified in official BytePlus docs, but they follow the official `dreamina-seedance-2-5-260628` pattern]**
- Timeline: Seedance 2.5 was announced on 2026-06-23 at Volcengine FORCE ([Digital Applied](https://www.digitalapplied.com/blog/seedance-2-5-bytedance-ai-video-model-2026)). A 2026-08-07 report describes 30 s single generation, multi-round extension, up to 30 images / 10 videos / 10 audios as references, and precise timestamp control ([163.com](https://www.163.com/dy/article/L3NLBSHE05199NHJ.html)). Consumer release on 2026-07-31 per secondary trackers ([DataLearner](https://www.datalearner.com/en/ai-models/pretrained-models/seedance-2-5)). One developer post says the ModelArk API opened on Aug 7 ([dev.to](https://dev.to/sinpo_wang_259d6993245baa/seedance-25-what-developers-need-to-know-about-bytedances-30-second-video-generation-api-4b0k))
- Seedance 2.0 pricing went public on 2026-03-04 (consistent with the 2.0 launch in Feb 2026) — [Sina Finance](https://finance.sina.com.cn/jjxw/2026-03-05/doc-inhpwviu3314395.shtml)
- Draft (样片) mode for the Seedance 2.5 API launched on 2026-09-22 — [Sohu](https://www.sohu.com/a/1079574815_122066678)
- "Seedance 2.5 4K" (4K, 10-bit, draft at 480p then 4K final) is reportedly open only to some enterprise customers. Reported 2026-10-26; secondary source, no model ID — [ai-bot.cn](https://ai-bot.cn/seedance-2-5-4k)

### Inferences
- The date suffix in each model ID is a build date (YYMMDD): 250528, 251015, 251215, 260128, 260615, 260628. Pin the exact ID in config and expect new suffixes.
- For an ad agent: use **Seedance 2.5** for final 30 s single-shot-sequence renders, **2.0 fast/mini** (480p/720p only) for cheap iteration, and **1.0 pro fast** only if you need the `flex` 50%-off offline tier (2.x has no flex).
- Seedance 1.5 pro seems to have been retired or hidden in the China region docs but is still offered on BytePlus. Treat it as legacy.

### Gaps
- No official ByteDance Seed (seed.bytedance.com) page for 2.5 was retrieved. Release dates come from press and secondary sources.
- No official model ID or API access path was found for "Seedance 2.5 4K".
- Seedance 1.0 lite (older `…-lite-t2v/i2v-250428` IDs) is absent from current docs. I could not confirm whether it is retired.
- Could not confirm the BytePlus IDs for 1.0 pro / 1.0 pro fast (likely `seedance-1-0-pro-250528` / `seedance-1-0-pro-fast-251015`) **[unverified]**.

## 2. Capabilities (T2V, I2V, first/last frame, multi-reference, multi-shot, audio, durations, resolutions, ratios, fps, camera, extension, editing)

### Takeaway
Seedance 2.x is a single "omni" model: text-to-video, first-frame or first+last-frame image-to-video, and **全模态参考** (multi-image + multi-video + multi-audio references), which also covers **video editing and video extension**. It generates audio natively (dialogue, SFX, music; stereo). 2.5 raises the limits to 30 s output and 30 images / 10 videos / 10 audios. All models output 24 fps. Six fixed aspect ratios plus `adaptive`.

### Cited Findings
- **Capability matrix** (official): T2V, I2V-first-frame: all six models. I2V-first+last: all except 1.0 pro fast. Image / video reference, edit, extend, audio generation, web-search tool: 2.5 and the 2.0 series only. Audio-only reference: 2.5 only (2.0 needs an image or video alongside). Return last frame: all. Offline (flex) inference: only 1.0 pro / pro fast — [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- **Durations** (official): 2.5 4–30 s; 2.0 / fast / mini 4–15 s; 1.0 pro / pro fast 2–12 s. 24 fps for all. Output container mp4 (2.5 can also output `mov`) — [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial); [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- `duration` parameter (official): 2.5 accepts [4,30] or -1, **default -1** (the model picks the length). 2.0 series [4,15] or -1. 1.0 [2,12]. The query API returns duration = floor(total_frames/24). "视频时长与计费相关，请谨慎设置" — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api). BytePlus lists defaults: 2.0 series default 5; 1.5 pro default 5, [4,12] or -1 — [BytePlus create task](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- `frames` (1.0 only): [29, 289], values of the form 25+4n; takes priority over `duration` — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Resolutions** (official): 2.5 480p/720p/1080p (default 720p; 1080p is 10-bit H.265/HEVC). 2.0 480p/720p/1080p/4k (4k is 10-bit HEVC). 2.0 fast and 2.0 mini 480p/720p only. 1.0 pro / pro fast 480p/720p/1080p (default 1080p). BytePlus adds 1.5 pro: default 720p, 480p/720p/1080p — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- **Aspect ratios**: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, `adaptive`. Pixel sizes, e.g. 2.5/2.0 at 720p: 16:9 = 1280×720, 9:16 = 720×1280, 1:1 = 960×960; at 1080p: 1920×1080 / 1080×1920; 2.0 at 4k: 3840×2160. 1.0 sizes differ slightly (e.g. 1080p 16:9 = 1920×1088). For 2.5, first-frame, first+last-frame, edit and extend tasks only allow `adaptive` (output follows the input image or video) — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Reference limits** (official): images 1–30 for 2.5 and 1–9 for the 2.0 series (role `reference_image`). Videos: 2.5 up to 10, each 2–30 s (4–30 s for edit tasks), total ≤30 s; 2.0 up to 3, each 2–15 s, total ≤15 s. Audio: wav/mp3; 2.5 up to 10, each 2–30 s, total ≤30 s; 2.0 up to 3, total ≤15 s, ≤15 MB each — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Mutually exclusive modes**: first-frame, first+last-frame and omni-reference cannot be mixed in one request. With omni-reference you can ask in the prompt for a reference image to act as the first or last frame, but strict frame matching needs the first/last-frame mode — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Audio**: `generate_audio` (default true, 2.x only) generates voices, SFX and BGM synced to the picture. Put dialogue in double quotes. Output is always stereo — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Editing / extension** (2.x): the official examples cover editing (e.g. repainting a house façade with weather taken from a reference image) and extension ("将视频1向后延长 … 11秒", or chaining several clips into one coherent video) — [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial). For 2.5, `omni_reference_task_type` = `auto|reference|edit|extend`. Edit needs a reference_video of 4–30 s, `ratio:"adaptive"`, `duration:-1`. Extend needs a reference_video and `ratio:"adaptive"` — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Multi-shot inside one generation**: the official 2.5 example is a 15 s fruit-cookie **ad** prompt. It specifies an opening shot, cut to close-ups, a slow-motion climax, a horizontal array and an end-card with an English slogan, and binds each beat to `@图像1` / `@视频1…6` references — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api); English version uses `@Image1` / `@Video1` — [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- **Camera control**: `camera_fixed` exists only for 1.0 pro / pro fast. It works by appending "固定摄像头" to the prompt, and the effect is not guaranteed. Other camera moves are prompt-driven (e.g. the official "360度环绕运镜" first/last-frame example) — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- **Seed**: the `seed` parameter is documented for 1.0 pro / pro fast. The same seed gives "similar but not identical" results — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Prompt languages**: all models take Chinese and English. 2.5 adds es, id, pt, ja, ms, th, ar, vi, ko; 2.0 adds es, id, pt, ja. Recommended length ≤500 Chinese characters or ≤1000 English words — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Web search tool**: `tools:[{"type":"web_search"}]` (2.x) lets the model search the web (e.g. product info), at the cost of extra latency. Usage is reported in `usage.tool_usage.web_search` — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- **Output format**: 2.5 `output_format` is `mp4` (default) or `mov` (H.264, yuv444p, PCM audio; recommended for edit/extend round-trips) — [create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Third-party guides describe Seedance 2.5 timestamp prompting (mark only key beats) and shot-list prompts ("Shot 1 close-up…, Shot 2 …"). No official timestamp syntax reference was found — [Luma guide](https://lumalabs.ai/learning-center/articles/intro-to-seedance-2-5); [Kapwing](https://www.kapwing.com/resources/how-to-prompt-seedance-2-5-a-guide-for-ai-video-creators/)

### Inferences
- For ads, the most useful mode is 2.5 omni-reference: product packshots as `reference_image` (up to 30), style or motion references as `reference_video`, and a brand jingle or voiceover as `reference_audio`. The prompt then binds each beat to `@图像N/@视频N`.
- Always set `duration` explicitly on 2.5. The default `-1` lets the model choose the length, and cost scales with length.
- 2.5 does not do 4K via the public API (2.0 does). 1080p from 2.5 and 4K from 2.0 are 10-bit HEVC, so transcode to 8-bit H.264 before social upload or browser playback.

### Gaps
- No official documented syntax for timestamps (e.g. "0–3s: …") or explicit shot-cut tokens. These are prompt conventions only.
- No official statement on lip-sync quality or speech languages for generated dialogue beyond the prompt-language list.

## 3. API: Volcengine Ark & BytePlus ModelArk — base URLs, auth, request/response JSON, async polling, callbacks, result URLs, rate limits

### Takeaway
One async REST resource on both clouds: `POST {base}/contents/generations/tasks` returns `{"id":"cgt-…"}`. Then poll `GET {base}/contents/generations/tasks/{id}` or receive a `callback_url` POST. Auth is `Authorization: Bearer <ARK_API_KEY>`. Download `content.video_url` immediately: it expires after 24 h, and 2.5 URLs allow at most 100 downloads. 2.0 limits: RPM 600 / max 10 concurrent tasks (enterprise), 180 / 3 (personal).

### Cited Findings
**Endpoints and auth**
- China: `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks` and `GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}`. API-key auth only (long-lived key from the API Key 管理 page) — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [get](https://www.volcengine.com/docs/ark/get-video-generation-task-api)
- International: `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`. "This API supports only API Key authentication" — [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- The `model` field takes a Model ID or an Endpoint ID. An Endpoint ID gives you rate-limit, prepaid/postpaid billing, monitoring and security controls — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- SDKs from the official samples: Python `from arkruntime import Ark` ("python -m pip install --upgrade arkruntime"), `client.content_generation.tasks.create(...)` / `.get(task_id=...)`; Java `com.volcengine.ark.runtime` (`ArkService.getContentGenerationTask`); Go `github.com/volcengine/ark-runtime-go/arkruntime` — [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial). Non-standard body fields go through `extra_body` in Python, e.g. `extra_body={"omni_reference_task_type":"reference","output_format":"mov"}` — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Other video endpoints exist: list tasks, and cancel/delete a task — [create page nav](https://www.volcengine.com/docs/ark/create-video-generation-task-api). Only `queued` tasks can be cancelled. A cancelled task is auto-deleted after 24 h — [get](https://www.volcengine.com/docs/ark/get-video-generation-task-api)

**Request body fields** (all from the official create-task docs, [Volcengine](https://www.volcengine.com/docs/ark/create-video-generation-task-api) / [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api))
- `model` (required); `content[]` (required). Item types:
  - `{"type":"text","text":…}`
  - `{"type":"image_url","image_url":{"url":…},"role":"first_frame"|"last_frame"|"reference_image"}`. The url can be a public URL, `data:image/png;base64,…`, or `asset://<ASSET_ID>`.
  - `{"type":"video_url","video_url":{"url":…},"role":"reference_video"}`
  - `{"type":"audio_url","audio_url":{"url":…},"role":"reference_audio"}`
  - `{"type":"draft_task","draft_task":{"id":…}}`
- Also: `resolution`, `ratio`, `duration`, `frames` (1.0), `seed` (1.0), `camera_fixed` (1.0), `watermark` (default false), `generate_audio` (default true), `return_last_frame` (default false), `draft` (default false), `output_format` (2.5), `omni_reference_task_type` (2.5), `service_tier` (`default` | `flex`; flex = 50% price, 1.0/1.5 only), `callback_url`, `execution_expires_after` (default 172800 s, range [3600, 259200]), `priority` (0–9, 2.x only, re-orders the queue within an Endpoint), `safety_identifier` (hashed end-user ID, ≤64 chars), `tools`.
- Input limits: images jpeg/png/webp/bmp/tiff/gif (heic/heif on 2.0+), aspect ratio 0.4–2.5, sides 300–6000 px, <30 MB each. Videos mp4/mov (H.264/H.265), ≤200 MB, 24–60 fps, total pixels 407,696–8,295,044. Request body ≤64 MB, so avoid base64 for large files.
- Legacy "weak validation" flags appended to the prompt also work: `--rs 720p --rt 16:9 --dur 5 --seed 11 --cf false --wm true`.

#### Example A — text-to-video (assembled from documented fields; Volcengine; swap base URL + `dreamina-…` ID for BytePlus)
```bash
curl -X POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks \
  -H "Content-Type: application/json" -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "doubao-seedance-2-0-260128",
    "content": [{"type": "text", "text": "Vertical 9:16 sneaker ad. Shot 1: macro of sole hitting wet asphalt... Shot 2: ... Voiceover: \"Run the city.\""}],
    "resolution": "720p", "ratio": "9:16", "duration": 10,
    "generate_audio": true, "watermark": false,
    "callback_url": "https://agent.example.com/hooks/ark",
    "execution_expires_after": 7200
  }'
# -> {"id": "cgt-2026******-****"}
```
(Field names and semantics from the [create-task doc](https://www.volcengine.com/docs/ark/create-video-generation-task-api); BytePlus response shape `{"id": "cgt-2026******-****"}` shown verbatim in the [BytePlus doc](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api).)

#### Example B — image-to-video, first frame (official sample, Python, Seedance 2.5)
```python
client = Ark(base_url="https://ark.cn-beijing.volces.com/api/v3", api_key=os.environ["ARK_API_KEY"])
r = client.content_generation.tasks.create(
    model="doubao-seedance-2-5-260628",
    content=[
        {"type": "text", "text": "女孩抱着狐狸，女孩睁开眼，温柔地看向镜头……可以听到风声"},
        {"type": "image_url", "image_url": {"url": "https://arkdocs.tos-cn-beijing.volces.com/images/video-generation/i2v_foxrgirl.png"}}
    ],
    generate_audio=True, ratio="adaptive", duration=5, watermark=True)
# poll: client.content_generation.tasks.get(task_id=r.id) every 10 s until succeeded/failed
```
— [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial). For first+last frame, send two `image_url` items with `"role":"first_frame"` and `"role":"last_frame"`. If the aspect ratios differ, the first frame wins and the last frame is cropped — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)

#### Example C — omni-reference ad with reference image + reference videos (official BytePlus cURL, abbreviated)
```json
{
  "model": "dreamina-seedance-2-5-260628",
  "content": [
    {"type": "text", "text": "A bright, colorful advertising-film style with fruit-flavored cookies... The strawberry flavor refers to @Image1... referring to the composition of @Video1... At the end, the English text \"One bite of crispness, a heart full of delight\" appears... referring to @Video5..."},
    {"type": "image_url", "image_url": {"url": "https://arkdocs-en.tos-ap-southeast-1.volces.com/images/video-generation/seedance2.5_reference1.png"}, "role": "reference_image"},
    {"type": "video_url", "video_url": {"url": "https://arkdocs-en.tos-ap-southeast-1.volces.com/videos/video-generation/seedance2.5_reference2.mp4"}, "role": "reference_video"}
    /* ... 5 more reference_video items ... */
  ],
  "generate_audio": true, "ratio": "16:9", "duration": 15,
  "omni_reference_task_type": "reference", "output_format": "mov", "watermark": true
}
```
— [BytePlus create task](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api) (the same example in Chinese is at [Volcengine](https://www.volcengine.com/docs/ark/create-video-generation-task-api))

#### Example D — draft → final (Seedance 2.5; official mechanism)
Step 1: create with `"draft": true` (480p only). Step 2: create with `"content":[{"type":"draft_task","draft_task":{"id":"<draft task id>"}}]`. Some parameters are reused automatically, some must not be re-sent, and some can be changed (detailed rules are in the "Seedance 2.5 样片模式" doc). Draft task IDs created on or after 2026-10-28 10:00 (UTC+8) are valid for 14 days (7 days before that) — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api). On Volcengine only 2.5 supports draft mode ([tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)). BytePlus lists 2.5 and 1.5 pro ([BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)).

#### Example E — query response (official, Seedance 2.0, 5 s 720p)
```json
{"id":"cgt-2026****-****","model":"doubao-seedance-2-0-260128","status":"succeeded",
 "content":{"video_url":"https://ark-content-generation-cn-beijing.tos-cn-beijing.volces.com/xxx"},
 "usage":{"completion_tokens":108900,"total_tokens":108900},
 "created_at":1779348818,"updated_at":1779348874,"seed":78674,"resolution":"720p","ratio":"16:9",
 "duration":5,"framespersecond":24,"service_tier":"default","execution_expires_after":172800,
 "generate_audio":true,"draft":false,"priority":0}
```
— [Volcengine get task](https://www.volcengine.com/docs/ark/get-video-generation-task-api)

**Status, callbacks, result retention**
- Status values: `queued`, `running`, `cancelled`, `succeeded`, `failed`, plus `expired` when the task is still queued or running past `execution_expires_after` — [get](https://www.volcengine.com/docs/ark/get-video-generation-task-api); [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- `callback_url`: Ark POSTs a body identical to the GET response on each status change (queued, running, succeeded, failed, expired). For succeeded and failed, if delivery is not acknowledged within 5 s it is retried 3 times — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api). The tutorial includes a Flask webhook sample with idempotent upsert by task_id — [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- `video_url` and `last_frame_url` (jpeg, unwatermarked, same size as the video; returned when `return_last_frame:true`) are **valid for 24 h**. Seedance 2.5 URLs allow **at most 100 downloads**. Only the last 7 days of tasks can be queried. Volcengine recommends TOS data subscription to auto-copy outputs to your bucket — [get](https://www.volcengine.com/docs/ark/get-video-generation-task-api); [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- 2.5 errors for some task types surface only when the queued task is picked up (asynchronous errors such as `InvalidParameter.TaskTypeConstraint` and `InvalidParameter.TaskTypeMismatch`). Setting `omni_reference_task_type` explicitly moves some validation to submit time — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [get](https://www.volcengine.com/docs/ark/get-video-generation-task-api)

**Rate limits / concurrency**
- Limits apply per main account per model (all versions combined). Going over returns `429 Too Many Requests`. RPM caps task creation. Max concurrency caps tasks in processing, and extra tasks queue. Non-inference QPS per account: get task 20, list tasks 1, cancel/delete 20 — [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- From the 2026-05 model-list snapshot: 2.0 and 2.0 fast have max RPM 600 (enterprise) / 180 (personal) and max concurrency 10 (enterprise) / 3 (personal), no flex. 1.5 pro / 1.0 pro / 1.0 pro fast have RPM 600, concurrency 10, flex TPD 500 billion tokens. Limits are "非刚性保障" (not guaranteed) — [Volcengine 模型列表 snapshot](https://www.volcengine.com/docs/82379/1330310)
- Activation preconditions for 2.5 / 2.0 series: Volcengine needs a balance over ¥200, a ¥200+ savings plan, or a resource pack — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api). BytePlus needs a balance over USD 30, a USD 30+ AI Savings Plan, or a Seedance resource pack — [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)

### Inferences
- Agent tool design: `create_video(...)` returns a task_id right away. Then use a webhook (preferred) or polling at 5–10 s intervals with a cap (the official sample gives up after 30 min). On success, stream the mp4 to your own object storage at once, because of the 24 h expiry and 100-download cap. Make the webhook idempotent, since callbacks retry.
- With only 3 (personal) or 10 (enterprise) concurrent 2.x tasks per account, a multi-shot ad needs a job queue. Use `priority` so interactive previews jump ahead of batch renders. Apply for an enterprise account or Endpoint quotas for production.
- Set `execution_expires_after` to about 3600–7200 s for interactive flows. The default is 48 h, so stuck tasks would otherwise hang around.

### Gaps
- The exact paths and query params of the list and cancel/delete endpoints were not fetched (by convention probably `GET …/tasks?page_num=&page_size=&filter.status=` and `DELETE …/tasks/{id}`) **[unverified]**.
- The current (Oct 2026) RPM and concurrency for Seedance 2.5 and 2.0 mini were not found. The model-list page read was a 2026-05 snapshot.
- Callback authentication or signature (how to verify that a webhook came from Ark) is not documented on the pages read.

## 4. Max clip duration, how practitioners reach ~30 s, and keeping product/character consistent

### Takeaway
Seedance 2.5 natively produces **up to 30 s in one coherent generation**, with in-prompt multi-shot cuts, so a 30 s ad can be a single task. Seedance 2.0 tops out at 15 s, so 30 s needs about 2 clips joined by **last-frame chaining** (`return_last_frame` → next `first_frame`), by the native **extend** task, or by stitching independent shots in post. Consistency relies on reusing the same `reference_image` set (product packshots, character sheet) in every task, explicit `@图像N` bindings in the prompt, and edit/extend tasks on earlier outputs.

### Cited Findings
- 2.5: "支持生成全新视频、编辑视频、延长视频，支持 30 秒视频连贯直出"; duration range [4,30] — [Volcengine create task](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- 2.0 series: 4–15 s; 1.0: 2–12 s — [Volcengine tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- Official chaining recipe: `return_last_frame:true` returns the last frame (jpeg, no watermark), which then becomes the next task's first frame. The tutorial "生成多个连续视频" has a loop that generates 3 consecutive clips — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- Official extension: "向前或者向后延长视频，或多个视频片段串联成一个连贯视频" (extend forwards or backwards, or merge several clips into one coherent video). Input reference videos are capped at ≤15 s total (2.0) and ≤30 s total (2.5) — [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial); [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- For edit/extend, `mov` output is recommended for "画面色彩与亮度一致性" (consistent colour and brightness) in round-trips — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Reusing your own outputs: the platform trusts face-containing videos generated by 2.5 / 2.0 under the same account in the last 30 days, so they can be fed back as inputs for further editing — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Press coverage says 2.5 supports multi-round extension beyond 30 s and "精准的时间戳控制" — [163.com](https://www.163.com/dy/article/L3NLBSHE05199NHJ.html); third-party summaries say Seedance 2.5 4K emphasises keeping small text on packaging legible across shots — [ai-bot.cn](https://ai-bot.cn/seedance-2-5-4k)
- Practitioner guides recommend giving each reference an explicit role ("@Image1 = product, @Image2 = scene/lighting") rather than bare tags, and keeping a recurring object as the continuity anchor across shots — [Kapwing](https://www.kapwing.com/resources/how-to-prompt-seedance-2-5-a-guide-for-ai-video-creators/); [Luma prompting guide](https://lumalabs.ai/learning-center/articles/seedance-2-5-prompting-guide)

### Inferences
- Recommended 30 s ad pipeline:
  1. An LLM writes a shot list and timing.
  2. 2.5 draft at 480p for the whole 30 s, or per shot, to validate.
  3. Final render at 720p/1080p from the draft ID.
  4. If a beat is wrong, run a targeted `edit` task on the clip instead of rerolling.
  5. Add logo, legal text and price overlays in post (ffmpeg), not in-model. In-model text is possible (official example), but brand-critical text should be deterministic.
- With 2.0, plan 2×15 s or 3×10 s segments. Use omni-reference with the same packshot images in each segment and bind them in the prompt. Note that first-frame chaining and omni-reference are mutually exclusive in one request, so either chain via the first frame (and lose references) or use omni-reference with "以@图像1为首帧" prompting (looser continuity).
- Generated audio across chained clips will not be continuous. For multi-segment ads, set `generate_audio:false` (or replace the audio) and lay a single VO/music track in post. Alternatively use 2.5 single-pass 30 s with a `reference_audio` jingle.

### Gaps
- No official guidance quantifies identity or product drift across chained clips. No benchmark of chaining vs native 30 s was found.
- The maximum total length reachable by repeated 2.5 extensions is not documented officially. Press mentions "多轮延长" (multi-round extension) without a cap.

## 5. Pricing, typical generation time, cheap draft modes

### Takeaway
Seedance bills **output tokens** (input tokens = 0), with a lower per-token price when the request includes video input (input video length also counts toward usage). In two official examples, tokens ≈ width × height × frames / 1024 at 24 fps. Reported list prices: Volcengine 2.5 ¥70 per million tokens (no video input) / ¥42 (with video input); 2.0 ¥46 / ¥28. BytePlus 2.5 about $10.70 / $6.40 per million tokens (≈$11.70 / $7.00 at 1080p). That puts a 5 s 720p 2.5 clip at roughly ¥7.6 / $1.17, and a 30 s 720p clip at roughly ¥45 / $6.9. No official latency SLA was found. Doc examples and press suggest about 1–12 minutes per clip depending on length, references and queueing. 2.5 draft mode (480p, then final via draft ID) is the official cheap preview path: about 57% cheaper in a 4-reroll 5 s 1080p scenario.

### Cited Findings
- Billing fields: `usage.completion_tokens` is the billing basis. Video models count no input tokens (total = completion). **Seedance 2.0 series has a minimum billable token amount**: if usage falls below it, the minimum is charged — [Volcengine get task](https://www.volcengine.com/docs/ark/get-video-generation-task-api)
- Official example: 2.0, 720p, 16:9, 5 s → 108,900 tokens — [get task](https://www.volcengine.com/docs/ark/get-video-generation-task-api). Tutorial example: 5 s 1080p → 246,840 tokens — [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)
- Seedance 2.0 prices (published 2026-03-04): ¥28 per million tokens with video input, ¥46 per million without; "about ¥1 per second" — [Sina Finance](https://finance.sina.com.cn/jjxw/2026-03-05/doc-inhpwviu3314395.shtml)
- Seedance 2.5 on Volcengine: ¥70 per million tokens without video input, ¥42 with video input (secondary) — [Leadde](https://leadde.ai/blog/how-much-is-seedance-2-5); a cost explainer gives a token formula covering input and output duration, resolution and fps, and estimates 720p 5 s ≈ ¥7.56 — [ai-indeed](https://www.ai-indeed.com/encyclopedia/29280.html)
- Seedance 2.5 on BytePlus: $10.70 per million tokens without video input, $6.40 with video input ([CometAPI](https://www.cometapi.com/seedance-2-5-api-pricing/); [SaaS CRM Review](https://saascrmreview.com/seedance-pricing/)). A later 1080p rate of $11.70 / $7.00 ([Cellcog](https://cellcog.ai/blog/seedance-2-5-pricing/); [8frame](https://www.8frame.co/blog/seedance-2-5-price-comparison-2026)). A 72%-of-list 1080p promo ran until 2026-09-17 ([RealAITest](https://www.realaitest.com/article/seedance-api-pricing.html)). 5 s 16:9 ≈ $0.514 (480p) / $1.156 (720p) without video input ([CometAPI](https://www.cometapi.com/seedance-2-5-api-pricing/)) — all secondary
- BytePlus Seedance 2.0 per-second figures from search snippets: about $0.07/s at 480p, $0.15/s at 720p, $0.37/s at 1080p, $0.78/s at 4K; 2.0 fast about $0.12/s at 720p — [Kreatorflow](https://kreatorflow.ai/guides/seedance-api-pricing); [Framesurfer](https://framesurfer.com/blogs/seedance-2-0-pricing) (pages not opened; **[unverified]**)
- Flex (offline) tier: `service_tier:"flex"` is 50% of the online price with higher TPD, for latency-tolerant (e.g. hour-level) jobs. The current docs list only 1.0 pro / pro fast as supported, and 2.5 and the 2.0 series do not support it — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api); [tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial). The 2026-05 model-list snapshot also gave 1.5 pro a flex TPD of 500 billion tokens — [模型列表 snapshot](https://www.volcengine.com/docs/82379/1330310)
- Draft mode: 480p only. Volcengine's official estimate for a 2.5 1080p 5 s shot without video input, assuming 4 rerolls before an acceptable take: draft mode saves 57% of cost and is "nearly 2× faster". The 1080p final reuses the draft's generation parameters to keep structure and composition — [Sohu, 2026-09-22](https://www.sohu.com/a/1079574815_122066678)
- Latency evidence (all indirect):
  - The official 2.0 query example shows 56 s from created_at to updated_at for 5 s 720p ([get task](https://www.volcengine.com/docs/ark/get-video-generation-task-api)).
  - The official 2.5 omni-reference sample (1 reference image + 6 reference videos, output 720p mov) shows 699 s (~11.7 min) ([create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)). Its timestamps (2026-04-14) predate 2.5's release, so the response looks recycled from a 2.0 run and is illustrative only. The tutorial's 5 s 1080p example (84 s) is dated 2025-12-12, which also predates 2.x ([tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)).
  - The official Python sample polls every 10 s with a 30 min deadline ([create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)).
  - The docs only say generation "可能耗时较长" depending on model, load and output spec ([tutorial](https://www.volcengine.com/docs/ark/video-generation-tutorial)).
- Capacity crunch context (consumer app, not API): in March 2026, Jimeng users reported waits of 6–8 h for a 10 s Seedance 2.0 video — [36Kr](https://m.36kr.com/p/3718471239038593)
- Resellers (fal, Kie, APIMart, Runway etc.) charge different per-second rates, e.g. Kie lists 2.5 at $0.14 / $0.315 / $0.79 per second (480p / 720p / 1080p) — [Kie.ai](https://kie.ai/blog/seedance-2-5-pricing); [OpenRouter listing](https://openrouter.ai/bytedance/seedance-2.5)

### Inferences
- **Token formula** (inference, matches both official examples exactly): tokens = W × H × (24·duration + 1) / 1024. 1280×720×121/1024 = 108,900 ✓, and 1920×1088×121/1024 = 246,840 ✓ (1.0-series 1080p frame). Estimated costs (no video input):

| Model / res | 5 s | 10 s | 15 s | 30 s |
|---|---|---|---|---|
| 2.5 480p (854×480) | 48k tok → ¥3.4 / $0.52 | ¥6.8 / $1.03 | ¥10.1 / $1.55 | ¥20.2 / $3.09 |
| 2.5 720p | 109k tok → ¥7.6 / $1.17 | ¥15.2 / $2.32 | ¥22.7 / $3.48 | ¥45.4 / $6.94 |
| 2.5 1080p | 245k tok → ¥17.2 (if ¥70) / $2.87 (at $11.70) | $5.71 | $8.55 | ¥102 / $17.1 |
| 2.0 720p (¥46) | ¥5.0 | ¥10.0 | ¥15.0 | n/a (max 15 s) |

  These are estimates. Reference-video inputs switch to the cheaper "with video input" price but add their own length to usage, and 2.0 applies a minimum charge.
- Cheapest iteration loop for an agent: storyboard frames with an image model, then 2.0 fast/mini at 480p (or 2.5 draft at 480p) for previews, then a 2.5 final at 720p for social or 1080p for hero. Draft mode beats "480p then upscale" because the final is rendered natively from the draft's structure.
- Plan latency budgets of minutes, not seconds. Run segments in parallel up to the concurrency cap, and show users draft previews while finals render.

### Gaps
- The **official** Volcengine and BytePlus price tables (模型价格 / Pricing) were not readable (JS-rendered). Official prices for 2.0 fast, 2.0 mini, 1.5 pro, 1.0 pro / pro fast in Oct 2026, the 2.5 1080p tier on Volcengine, the draft-mode billing rule, and 2.0's minimum token amount are unverified.
- No measured p50/p95 generation-time benchmarks for 5–10 s 720p/1080p API jobs were found from reliable sources.

## 6. Restrictions: moderation, real human faces, IP/brands, watermarks, regional availability

### Takeaway
Seedance 2.x **rejects reference images or videos containing real human faces**. The workarounds are ByteDance's preset virtual-human asset library (`asset://…`), authorized real-person assets, or re-feeding your own recent Seedance outputs. The visible "AI生成" watermark is opt-in (`watermark` defaults to false). After Disney, MPA, Paramount and WBD cease-and-desist letters (Feb 2026), ByteDance pledged stronger IP and likeness safeguards, so expect refusals on famous IP and characters. China access is via Volcengine; international access via BytePlus (ap-southeast). BytePlus terms reportedly exclude the US.

### Cited Findings
- "Seedance 2.5、Seedance 2.0 系列模型不支持直接上传含有真人人脸的参考图 / 视频" (2.5 and the 2.0 series do not accept reference images or videos with real faces). The listed solutions: use face-containing raw outputs of certain models as inputs, use preset virtual portraits, and use authorized real-person assets — [Volcengine create](https://www.volcengine.com/docs/ark/create-video-generation-task-api); same in English ("Create portrait videos with Dreamina Seedance models") — [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api)
- Asset IDs: `asset://<ASSET_ID>` from the "素材 & 虚拟人像库" (preset materials and virtual humans, including audio assets) can be used as image, video or audio inputs — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Watermark: `watermark` defaults to **false**; true adds an "AI生成" mark at the bottom right. Last-frame images are unwatermarked — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- Abuse tracking: `safety_identifier` (a hashed per-end-user ID) helps the platform detect policy-violating users — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api)
- IP: Disney sent a cease-and-desist on 2026-02-13 and the MPA on 2026-02-20 (its first ever to a major AI company); Paramount and Warner Bros. objected too. ByteDance said it is "taking steps to strengthen current safeguards" against unauthorized IP and likeness use, and reportedly paused uploads of real-person images — [Variety](https://au.variety.com/2026/film/news/bytedance-safeguards-seedance-disney-legal-threat-ip-violations-33139/); [Digital Music News](https://www.digitalmusicnews.com/2026/02/17/bytedance-seedance-2-0-legal-threats/); [TheWrap](https://www.thewrap.com/industry-news/tech/bytedance-ai-safeguards-seedance-disney-paramount)
- Regions: Volcengine runs in cn-beijing (`ark.cn-beijing.volces.com`) — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api). BytePlus runs in ap-southeast (`ark.ap-southeast.bytepluses.com`) — [BytePlus](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api). Search summaries say BytePlus ModelArk regions are Johor (ap-southeast-1) and Dublin (eu-west-1), with all models in ap-southeast-1 — [BytePlus availability doc](https://docs.byteplus.com/en/docs/ModelArk/availability) (JS page, not read directly; **[unverified]**)
- US availability: a write-up of the BytePlus Specific Terms for video generation says the service is **unavailable in the United States** ([TechJack Solutions](https://techjacksolutions.com/?p=71940)). A report says the Seedance 2 global rollout excluded the US ([Development Today](https://developmentstoday.com/ai-robotics/bytedance-expands-seedance-2-global-rollout-excluding-us)). Cellcog also says BytePlus ModelArk is not sold in the US ([Cellcog](https://cellcog.ai/blog/seedance-2-5-pricing/)). A third-party site claims the opposite ([seedance2.so](https://seedance2.so/blog/seedance-2-usa-access)), so the sources conflict and the official terms page was not read.
- China AIGC labelling: the 《人工智能生成合成内容标识办法》 (effective Sept 2025) requires explicit plus implicit (metadata) labels on AI content — [Zhihu explainer](https://zhuanlan.zhihu.com/p/1946573126205945284).

### Inferences
- Ads featuring real spokespeople cannot simply upload the talent's photo. The options are a virtual presenter from the asset library, ByteDance's authorized-real-person flow (needs consent paperwork), or a product-only or hands-only creative.
- For brand safety, keep competitor logos, celebrity names and film or game IP out of prompts. Expect async `failed` tasks from moderation and build retry-with-rewrite logic in the agent.
- Even with `watermark:false`, assume outputs may carry implicit AIGC metadata (China) and disclose AI use where platforms require it.

### Gaps
- Moderation error codes and categories for video tasks (sensitive content, IP, minors) were not retrieved (they live on the 错误码 page).
- Whether Volcengine and BytePlus embed implicit watermarks or C2PA metadata in outputs is not stated on the pages read **[unverified]**.
- The exact authorization workflow for "已授权真人素材" (authorized real-person assets: consent forms, review time) was not retrieved.
- The BytePlus Specific Terms page (US exclusion) was not read directly.

## 7. Brief comparison: Kling API, Google Veo 3.x / Gemini Omni, xAI Grok Imagine, Alibaba Wan

### Takeaway
As of late Oct 2026, three API rivals match or beat Seedance 2.5's 30 s single-pass length: **Kling 4.0** (≤30 s, ~$0.157/s at 720p via fal/Runware), **Gemini Omni Flash** (extend to 40 s total, ~$0.10/s at 720p) and **Wan 3.0** (claimed 30 s, API-only). **Veo 3.1 preview in the Gemini API was shut down on 2026-10-22**: use Gemini Omni Flash or GA Veo 3.1 on Google Cloud (Gemini Enterprise Agent Platform, formerly Vertex AI). **Grok Imagine Video 1.5** is ≤15 s but cheap ($0.08/s) and takes many references. **Wan 2.2** is the main open-weights option (Apache 2.0, ~5 s clips, self-hostable).

### Cited Findings

| API | Current models (Oct 2026) | Max length per call | Price (list, approx.) | Audio | References / control | Notable strengths / caveats |
|---|---|---|---|---|---|---|
| **Seedance (ByteDance)** | 2.5; 2.0 / fast / mini; 1.0 pro (+1.5 pro on BytePlus) | 30 s (2.5), 15 s (2.0) — [Volcengine](https://www.volcengine.com/docs/ark/video-generation-tutorial) | 2.5 ≈ $1.16 per 5 s at 720p without video input (secondary) — [CometAPI](https://www.cometapi.com/seedance-2-5-api-pricing/) | Native, stereo | Up to 30 img + 10 video + 10 audio refs; edit/extend; first/last frame; draft mode — [create](https://www.volcengine.com/docs/ark/create-video-generation-task-api) | Best-in-class multi-reference ad control; no real-face refs; US availability questionable |
| **Kling (Kuaishou)** | 3.0, **4.0** (global launch Oct 2026) and 4.0 Flash — [Wikipedia](https://en.wikipedia.org/wiki/Kling_AI) | 3.0: 3–15 s ([AITool Analysis](https://aitoolanalysis.com/kling-ai-video-length-limits/)); 4.0: 3–30 s; 4.0 Flash ≤20 s at 720p ([Runware](https://runware.ai/kling-4)) | Official API units $0.14 each; 3.0 ≈ $0.084/s at 720p silent, $0.168/s at 1080p with audio ([Seedrouter](https://seedrouter.ai/blog/kling-3-0-api-pricing); [AIReiter](https://aireiter.com/blog/kling-api-pricing)); 4.0 ≈ $0.157/s at 720p, $0.235/s at 1080p with sound (fal/Runware list) ([Runware](https://runware.ai/kling-4)) | Native (3.0+) | Multi-shot (3.0), extend to ~3 min total ([AITool Analysis](https://aitoolanalysis.com/kling-ai-video-length-limits/)) | Strong motion and physics; official Kling pricing pages not read (secondary only) |
| **Google Veo / Gemini Omni** | Gemini API: `gemini-omni-1.1-flash`; Veo 3.1 preview IDs (`veo-3.1-generate-preview`, `-fast-`, `-lite-`) **shut down 2026-10-22** ([Gemini video docs](https://ai.google.dev/gemini-api/docs/video)); GA `veo-3.1-generate-001` / `veo-3.1-fast-generate-001` on Google Cloud, retirement no earlier than 2026-11-17 ([LLM Reference](https://www.llmreference.com/model/veo-3.1-generate-001/gcp-vertex-ai)) | Omni: extensions add 3–10 s, up to 40 s total; input videos ≤10 s ([Omni docs](https://ai.google.dev/gemini-api/docs/omni)) | Omni ≈ $0.10/s ($17.50 per million video-output tokens, 5,792 tokens per second at 720p) ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)); Veo 3.1 ≈ $0.40/s at 720p/1080p, $0.60 at 4K; Fast $0.10–0.12; Lite $0.05 ([BenchLM](https://benchlm.ai/media-pricing/veo), secondary) | Native | Omni: first/last frame, subject reference images, ≤3 reference video clips of ≤3 s, multi-turn editing via Interactions API (`previous_interaction_id`); 360p/720p plus upscaled 1080p/4K; 16:9 and 9:16 ([Omni docs](https://ai.google.dev/gemini-api/docs/omni)) | SynthID on all outputs; no uploading or editing images of recognizable people; video editing of uploads unavailable in EEA/CH/UK ([Omni docs](https://ai.google.dev/gemini-api/docs/omni)) |
| **xAI Grok Imagine** | `grok-imagine-video-1.5` (aliases `-preview`, `-2026-05-30`); `grok-imagine-video` used for editing ([model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5); [Imagine docs](https://docs.x.ai/developers/model-capabilities/imagine)) | ≤15 s ([Imagine docs](https://docs.x.ai/developers/model-capabilities/imagine)) | $0.080 per output second on the model page ([model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5)); search summaries also cite $0.08 / $0.14 / $0.25 per second at 480p / 720p / 1080p and a "lite" from $0.02/s ([x.ai/api/imagine](https://x.ai/api/imagine)) — conflicting, check live pricing | Search summaries say audio is included; not stated on pages read | Up to 14 reference images + 3 voice references; pin first, last and mid frames; extend from last frame; edit; `POST https://api.x.ai/v1/videos/generations`, then poll `GET /v1/videos/{request_id}`; 10 rps ([Imagine docs](https://docs.x.ai/developers/model-capabilities/imagine); [model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5)) | Cheap, simple async API; US regions (us-east-1, us-west-2) ([model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5)) |
| **Alibaba Wan** | Open weights: **Wan 2.2** (T2V-A14B, I2V-A14B, TI2V-5B, S2V-14B, Animate-14B), Apache 2.0 ([GitHub](https://github.com/Wan-Video/Wan2.2)); API-only: Wan 2.7 ([Model Studio](https://help.aliyun.com/en/model-studio/wan2-7-t2v)) and Wan 3.0 (30 s, audio per [Morphic](https://morphic.com/resources/models/wan-3-0); open-weight status disputed per [HF community blog](https://huggingface.co/blog/ResterChed/wan-3-0)) | Wan 2.2: ~5 s clips (example 5 s 720p) ([GitHub](https://github.com/Wan-Video/Wan2.2)) | Self-host: GPU cost only. TI2V-5B runs on 24 GB with offload; 5 s 720p in <9 min on one consumer GPU; A14B needs 80 GB for single-GPU ([GitHub](https://github.com/Wan-Video/Wan2.2)). Wan 2.7 API (search summary of Model Studio page): Beijing ¥0.6/s at 720p, ¥1/s at 1080p ([Model Studio](https://help.aliyun.com/en/model-studio/wan2-7-t2v)) | Wan 2.2: speech-to-video (S2V) model; newer API models: native audio (secondary) | Wan 2.2: T2V, I2V, S2V, character animation and replacement | Only realistic self-hosted / no-vendor-policy option; weaker than closed models on length and audio |

- Veo 3.1 preview in the Gemini API was "shut down" on 2026-10-22. The recommended replacements are Gemini Omni Flash or GA Veo on the Gemini Enterprise Agent Platform — [Gemini API video docs](https://ai.google.dev/gemini-api/docs/video)
- Gemini Omni Flash is "generally available to developers on the paid tier", with no free tier — [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

### Inferences
- For a 30 s ad agent with heavy product-reference needs, Seedance 2.5 (reference richness, edit/extend, draft mode) and Kling 4.0 (30 s single pass) are the two closest fits. Gemini Omni Flash suits a conversational "edit this shot" loop because of multi-turn editing, but references are limited (≤3 short video refs, no audio refs). Grok Imagine is a low-cost fallback for 10–15 s segments. Wan 2.2 suits offline or self-hosted b-roll.
- Abstract the agent's video tool behind a provider interface `(prompt, refs[], first/last frame, duration, ratio, resolution, audio) → async job`. All five APIs are async create-then-poll, and limits differ mainly in max seconds, reference counts and face policy.

### Gaps
- Kling official API docs and price pages (klingai.com developer portal) were not read. All Kling numbers are secondary or vendor (fal / Runware / Atlas). Kling 4.0 direct-API availability and pricing need checking.
- The maximum single-generation length for Gemini Omni Flash, and official GA Veo 3.1 pricing on Google Cloud, were not confirmed. Veo 3.1 clip lengths (4/6/8 s) and its extend-to-~148 s behaviour are known from prior knowledge only **[unverified]**.
- Grok Imagine per-resolution pricing conflicts ($0.080/s on the model page vs $0.08/$0.14/$0.25 in search summaries), and its native audio support was not confirmed.
- Wan 3.0's official specs (duration, audio, open weights) and the currency and units of the Singapore Wan 2.7 price were not confirmed on Alibaba's own pages.
