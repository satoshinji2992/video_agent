// VideoAgentBench v0.2 evaluation: automatic checks, evidence, two MLLM judges on the user's rubric (Intent 25,
// Research 15, Planning 20, Visual/VFX 15, Editing/Sound 15, Execution/Delivery 10), and the three revision
// metrics for v2 against v1. VAB_TASK picks the task (vab-t1 DART, the default; vab-t2 coffee shop); results go to
// vab/ for Task 1 and to <task id>/ for the others.
//
// Subjects: run1-v1, run1-v2, run2-v1, run2-v2 (our runs, from runs/<task id>-runN.json; v1 = what stage A
// delivered, v2 = what stage B delivered) and grok (Grok's stage A video, black box).
//
// Usage (secrets only via --env-file):
//   node --env-file=<repo>/.env vab-eval.mjs evidence <subject>   -> vab/<subject>/evidence.json
//   node --env-file=<repo>/.env vab-eval.mjs judge <subject>      -> vab/<subject>/scores.json
//   node --env-file=<repo>/.env vab-eval.mjs revise <runN>        -> vab/<runN>-revision.json
// Env: VEVAL_JUDGE_SAMPLES (3), VEVAL_GEMINI_MODELS (gemini-3.5-pro,gemini-3.5-flash), VEVAL_FRAME_EVERY (3 s).
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { claudeJson, claudeJsonCC, extractFrame, fmtTime, geminiJson, ledgerFor, P, readJson, relay, SC, scrub, sessionDir, sh, topicById, writeJson } from './lib.mjs';

const TASK = topicById(process.env.VAB_TASK ?? 'vab-t1');
const VAB = join(SC, TASK.id === 'vab-t1' ? 'vab' : TASK.id);
// Evaluator-only facts about the asset pack (defective clips, facts that must not be invented); never shown to the agent.
const PACK = TASK.evaluator ? readJson(TASK.evaluator) : null;
// Python with the content-guard library and RapidOCR (guards/run.py and ocr.py run with it); without it the
// guard values and the OCR evidence are reported as unavailable and everything else still runs.
const PY = process.env.VAB_PY ?? join(SC, '.venv', 'bin', 'python');
const GUARDS_RUN = process.env.VAB_GUARDS_RUN ?? join(SC, 'guards', 'run.py');
// The black-box comparison system (subject "grok"): any external video plus a text file describing its conversation.
const GROK_VIDEO = process.env.VAB_EXTERNAL_VIDEO ?? '';
const GROK_CONVERSATION = `（以下是根据对话截图转述的过程，不是原始日志；没有工具调用记录和检索来源列表）
- 没有提任何澄清问题。一开始就说出了关键事实，并说明会先查资料、写脚本、再做视频。
- 在后台工作，并在关键节点汇报进度。
- 第一版剪完后自己检查，说发现并正在修复两个问题：配音把 “DART” 逐个字母读出来；有一段 1 秒的黑屏。
- 交付时附上：事实摘要；哪些镜头是 AI 生成的说明（画面内有标注）；署名与发布注意事项；一个包含 B 站标题、简介和标签的文件。`;
const EXTERNAL_NOTES = process.env.VAB_EXTERNAL_NOTES && existsSync(process.env.VAB_EXTERNAL_NOTES) ? readFileSync(process.env.VAB_EXTERNAL_NOTES, 'utf8') : null;
const EVERY = Number(process.env.VEVAL_FRAME_EVERY ?? 3);
const K = Math.max(1, Number(process.env.VEVAL_JUDGE_SAMPLES ?? 3));
// Judge A runs through Claude Code with this machine's login (start with the relay-only .env.cc); VAB_JUDGE_A=relay
// sends it to the relay's /v1/messages instead (only for production-style checks).
// Judge A runs on the relay API by default (the user, 2026-11-01: no subscription quota for tests); VAB_JUDGE_A=claude-code switches back.
const JUDGE_A_CHANNEL = process.env.VAB_JUDGE_A === 'claude-code' ? 'claude-code' : 'relay';
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null; })();
const GEMINI = (process.env.VEVAL_GEMINI_MODELS ?? 'gemini-3.5-pro,gemini-3.5-flash').split(',').map((x) => x.trim()).filter(Boolean);
const r2 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);

/* ------------------------------ subjects ------------------------------ */
function subject(key) {
  if (key === 'grok' && !GROK_VIDEO) throw new Error('subject grok needs VAB_EXTERNAL_VIDEO=<the external system\'s video>');
  if (key === 'grok') return { key, system: process.env.VAB_EXTERNAL_NAME ?? 'Grok', stage: 'A', video: GROK_VIDEO, conversation: EXTERNAL_NOTES ?? GROK_CONVERSATION, research: null, script: null, project: null };
  const m = /^(run\d+)-v([12])$/.exec(key);
  if (!m) throw new Error(`unknown subject ${key}`);
  const run = readJson(join(P.runs, `${TASK.id}-${m[1]}.json`));
  const st = run.stages?.[Number(m[2]) - 1] ?? stageFromCheckpoint(run, Number(m[2]) - 1);
  if (!st?.video?.path) throw new Error(`${key}: stage ${m[2] === '1' ? 'A' : 'B'} delivered no video`);
  const dir = sessionDir(run.sessionId);
  const project = readJson(st.video.projectSnapshot, null);
  const untilT = st.endT; // seconds since run start: evidence up to the end of this stage
  return {
    key, system: 'ours', run, runName: m[1], stage: st.name, stageInfo: st, video: st.video.path, version: st.video.version, project,
    conversation: conversationText(run, untilT, st.name === 'A' ? ['A'] : ['A', 'B']),
    research: researchOf(dir, run, untilT),
    script: scriptText(project, dir),
    media: TASK.assets ? mediaText(dir, project) : null,
  };
}

/**
 * While a driver is still running its run file has no per-stage summary yet; a finished stage can be
 * reconstructed from the checkpointed turns and events (video, timing, replies, cost from the ledger).
 */
function stageFromCheckpoint(run, idx) {
  const name = idx === 0 ? 'A' : 'B';
  const turns = run.turns.filter((t) => t.stage === name);
  if (!turns.length) return null;
  const startT = turns[0].sentAt;
  const nextStart = run.turns.find((t) => t.stage === (idx === 0 ? 'B' : 'C'))?.sentAt;
  const endT = nextStart ?? (run.inProgress ? null : Date.parse(run.endedAt) - Date.parse(run.startedAt));
  if (endT === null || endT === undefined) return null;
  const v = run.events.filter((e) => e.type === 'video' && e.t >= startT && e.t <= endT).at(-1);
  if (!v) return null;
  const dir = sessionDir(run.sessionId);
  const t0 = Date.parse(run.startedAt);
  const led = ledgerFor(run.sessionId, (e) => { const t = Date.parse(e.ts) - t0; return t >= startT - 1000 && t <= endT + 5000; });
  return {
    name, reached: true, startT: startT / 1000, endT: endT / 1000, wallSeconds: Math.round((endT - startT) / 100) / 10, secondsToVideo: Math.round((v.t - startT) / 100) / 10,
    userTurns: turns.length, replies: turns.map((t) => ({ n: t.n, text: t.text, reason: t.reason })),
    firstOutputMs: { turn1: turns[0].firstVisible?.ms ?? null, perTurn: turns.map((t) => t.firstVisible) },
    cost: { totalUsd: Math.round((led.nonClaudeUsd + led.claudeUsd) * 10000) / 10000, byKind: led.byKind },
    video: { version: v.version, path: join(dir, `versions/v${v.version}.mp4`), seconds: v.seconds, projectSnapshot: join(dir, `versions/v${v.version}.project.json`) },
    fromCheckpoint: true,
  };
}

/** The chat as the user saw it during the given stages, up to `untilT` seconds after the run start. */
function conversationText(run, untilT, stages) {
  const out = [];
  for (const t of run.turns) {
    if (!stages.includes(t.stage) || t.sentAt / 1000 > untilT + 1) continue;
    out.push(`[${(t.sentAt / 1000).toFixed(0)}s] 用户（阶段 ${t.stage}）：${t.text}`);
    const items = [...(t.botTexts ?? []).map((b) => ({ t: b.t, s: `助手：${b.text}` })), ...(t.cards ?? []).map((c) => ({ t: c.t, s: c.type === 'script' ? `[剧本卡 v${c.version}：${c.segments} 段，计划 ${c.total_seconds}s]` : c.type === 'ask' ? `[${c.mode === 'suggest' ? '建议卡' : '问题卡'}] ${c.question} 选项：${(c.options ?? []).join(' / ')}` : `[${c.type}] ${c.title ?? ''}` }))];
    for (const x of items.sort((a, b) => a.t - b.t)) out.push(`[${(x.t / 1000).toFixed(0)}s] ${x.s}`);
    if (t.end) out.push(`（本轮 ${(t.end.ms / 1000).toFixed(0)} 秒结束${t.end.ok ? '' : '，出错'}；首条可见输出 ${t.firstVisible ? (t.firstVisible.ms / 1000).toFixed(1) + ' 秒' : '无'}）`);
  }
  const lastT = Math.max(0, ...run.turns.filter((t) => stages.includes(t.stage)).map((t) => t.sentAt + (t.end?.ms ?? 0))) / 1000;
  const videos = run.events.filter((e) => e.type === 'video' && e.t / 1000 <= Math.min(untilT, lastT) + 1).map((e) => `[${(e.t / 1000).toFixed(0)}s] [成片] 第 ${e.version} 版 ${e.seconds}s`);
  return [...out, ...videos].join('\n');
}

/** Web research the agent did (queries, findings, sources) up to `untilT`, from its trajectory. */
function researchOf(dir, run, untilT) {
  const file = join(dir, 'trajectory.jsonl');
  if (!existsSync(file)) return [];
  const t0 = Date.parse(run.startedAt);
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    .filter((j) => (Date.parse(j.ts) - t0) / 1000 <= untilT + 1);
  const calls = new Map();
  for (const j of lines) {
    const tool = String(j.data?.tool ?? '');
    if (j.kind === 'tool_call' && tool.endsWith('__research')) calls.set(j.data.id, { at: j.ts, query: j.data.input?.query, findings: '', sources: [] });
    if (j.kind === 'tool_result' && tool.endsWith('__research') && calls.has(j.data.id)) {
      const out = j.data.output;
      calls.get(j.data.id).findings = String(Array.isArray(out) ? out.join('\n') : out ?? '').slice(0, 1500);
      calls.get(j.data.id).error = Boolean(j.data.error);
    }
    if (j.kind === 'ui' && j.data?.type === 'research') {
      const c = [...calls.values()].find((x) => x.query === j.data.query && !x.sources.length);
      if (c) c.sources = (j.data.sources ?? []).map((s) => ({ title: s.title, url: s.url }));
    }
  }
  return [...calls.values()];
}

/** The user's uploaded files as the session indexed them (media_index.json), by id. */
function mediaIndex(dir) {
  return new Map(readJson(join(dir, 'media_index.json'), []).map((m) => [m.id, m]));
}

/** Where a clip or uploaded-photo shot comes from: file name, in point, and the ingest flags of that stretch. */
function sourceOf(s, media) {
  const m = media.get(s.kind === 'clip' ? s.media : s.image);
  if (!m) return '';
  if (s.kind !== 'clip') return `｜素材 ${m.id}「${m.name}」`;
  const from = s.in ?? 0, to = from + s.seconds * (s.speed ?? 1);
  const segs = (m.segments ?? []).filter((g) => g.start < to && g.end > from);
  const flags = [...new Set(segs.flatMap((g) => g.flags ?? []))];
  return `｜素材 ${m.id}「${m.name}」${from.toFixed(1)}–${to.toFixed(1)}s${s.speed && s.speed !== 1 ? `（${s.speed} 倍速）` : ''}${s.reverse ? '（倒放）' : ''}${s.grade && s.grade !== 'none' ? `，调色 ${s.grade}` : ''}${s.keepAudio ? `，原声 ${s.keepAudio}` : ''}${flags.length ? `，入库标记：${flags.join('、')}` : ''}`;
}

/** The uploaded files and what ingest found in them (what the agent could see), and which ones the version uses. */
function mediaText(dir, project) {
  const media = mediaIndex(dir);
  if (!media.size) return '（会话里没有找到入库记录 media_index.json）';
  const used = new Set((project?.shots ?? []).flatMap((s) => (s.kind === 'clip' ? [s.media] : s.kind === 'image' ? [s.image] : [])));
  const lines = [...media.values()].map((m) => {
    const segs = (m.segments ?? []).filter((g) => g.flags?.length).map((g) => `${g.start.toFixed(1)}–${g.end.toFixed(1)}s ${g.flags.join('、')}${g.usable ? '' : '（不建议用）'}`);
    return `- ${m.id}「${m.name}」${m.kind}${m.duration ? ` ${m.duration.toFixed(1)}s` : ''}${m.status !== 'ready' ? `（${m.status}${m.error ? '：' + m.error : ''}）` : ''}${used.has(m.id) ? ' ★成片使用' : ''}${segs.length ? `｜${segs.join('；')}` : ''}${m.summary ? `｜描述：${String(m.summary).slice(0, 80)}` : ''}`;
  });
  return lines.join('\n');
}

function scriptText(project, dir) {
  if (!project) return null;
  const media = dir ? mediaIndex(dir) : new Map();
  const sc = project.script;
  const head = sc ? `剧本卡第 ${sc.version} 版《${sc.title}》${sc.aspect} 计划 ${sc.total_seconds}s，口播语言 ${sc.vo_language}；风格：${sc.style}；思路：${sc.insight}\n` +
    sc.segments.map((g) => `- [${g.id}] ${g.start}-${g.end}s ${g.role}｜画面：${g.visual}｜口播：${g.vo ?? '（无）'}｜字幕：${g.caption ?? '（无）'}${g.kind_hint ? `｜类型：${g.kind_hint}` : ''}`).join('\n') +
    (sc.sources?.length ? `\n剧本卡列出的来源：${sc.sources.map((s) => `${s.title} ${s.url}`).join('；')}` : '') : '（没有剧本卡）';
  let at = 0;
  const shots = (project.shots ?? []).filter((s) => !s.role || s.role === 'main').map((s) => {
    const line = `- ${fmtTime(at)}–${fmtTime(at + s.seconds)} 镜头 ${s.id}（${{ code: '代码动画', '3d': '3D 动画', seedance: 'AI 生成写实视频', image: '图片推拉', footage: '档案素材', clip: '用户素材剪辑' }[s.kind] ?? s.kind}${s.audio ? '，带同期声' : ''}）：${s.brief}${sourceOf(s, media)}｜计划口播：${s.vo ?? '（无）'}｜字幕：${s.caption ?? '（同口播）'}${s.voFile || (TASK.assets && !s.vo) ? '' : '｜⚠ 这个镜头在成片里没有配音文件'}${s.transition ? `｜转场 ${s.transition.type}` : ''}`;
    at += s.seconds;
    return line;
  });
  return `${head}\n\n成片实际使用的镜头（来自该版本的工程快照）：\n${shots.join('\n')}`;
}

/* ------------------------------ automatic checks ------------------------------ */
async function autoChecks(video, dir) {
  const { stdout } = await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,sample_rate,channels', '-of', 'json', video]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s) => s.codec_type === 'video') ?? {};
  const a = j.streams.find((s) => s.codec_type === 'audio') ?? null;
  const fps = (() => { const [x, y] = String(v.r_frame_rate ?? '0/1').split('/').map(Number); return y ? r2(x / y) : x; })();
  const probe = { duration: r2(Number(j.format.duration)), width: v.width, height: v.height, fps, videoCodec: v.codec_name, pixFmt: v.pix_fmt, audioCodec: a?.codec_name ?? null, sampleRate: a ? Number(a.sample_rate) : null, channels: a?.channels ?? null, bitrateKbps: Math.round(Number(j.format.bit_rate) / 1000) };
  let loud = null;
  if (a) {
    const { stderr } = await sh('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 });
    const sum = stderr.slice(stderr.lastIndexOf('Summary:'));
    const num = (re) => { const m = re.exec(sum); return m ? Number(m[1]) : null; };
    loud = { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), lraLu: num(/LRA:\s+(-?[\d.]+) LU/), truePeakDbtp: num(/Peak:\s+(-?[\d.]+) dBFS/) };
  }
  let tlb;
  try {
    const { stdout: o } = await sh(PY, ['-I', GUARDS_RUN, video], { maxBuffer: 20 * 1024 * 1024, timeout: 30 * 60_000 });
    tlb = JSON.parse(o.trim().split('\n').filter((l) => l.startsWith('{')).at(-1));
  } catch (e) {
    tlb = { error: String(e.stderr || e.message).slice(-600) };
  }
  const { stderr: bd } = await sh('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-vf', 'blackdetect=d=0.01:pic_th=0.80:pix_th=0.12', '-an', '-f', 'null', '-'], { maxBuffer: 64 * 1024 * 1024 });
  // Strict black: frames whose brightest pixel is still near black (YMAX <= 40 of 255). Dark space footage
  // with stars or a lit subject is not black; blackdetect at pic_th 0.80 / pix_th 0.12 counts it as black.
  const { stdout: st } = await sh('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-', '-an', '-f', 'null', '-'], { maxBuffer: 256 * 1024 * 1024 });
  const ymax = [...st.matchAll(/pts_time:([\d.]+)[\s\S]*?YMAX=([\d.]+)/g)].map((m) => ({ t: Number(m[1]), y: Number(m[2]) }));
  const strictBlack = [];
  for (const f of ymax) {
    const last = strictBlack.at(-1);
    if (f.y <= 40) {
      if (last && f.t - last.end <= 1.5 / (fps || 24)) { last.end = f.t; last.frames++; } else strictBlack.push({ start: f.t, end: f.t, frames: 1 });
    }
  }
  for (const b of strictBlack) { b.seconds = r2(b.end - b.start + 1 / (fps || 24)); b.where = b.start < 0.05 ? 'start' : b.end > probe.duration - 0.1 ? 'end' : 'mid'; }
  const black = [...bd.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]), seconds: Number(m[3]), frames: Math.round(Number(m[3]) * (fps || 24)), where: Number(m[1]) < 0.05 ? 'start' : Number(m[2]) > probe.duration - 0.05 ? 'end' : 'mid' }));
  return { probe, loudness: loud, tlb, black, blackMid: black.filter((x) => x.where === 'mid'), flashes: black.filter((x) => x.frames <= 2).length, strictBlack, strictBlackMid: strictBlack.filter((x) => x.where === 'mid'), framesMeasured: ymax.length };
}

// Whisper's well-known inventions on music or silence (the app's own list plus "感谢观看").
const HALLUCINATION = /字幕|订阅|點贊|点赞|打赏|Amara|谢谢观看|感谢观看|請不吝|请不吝|明镜|Thanks for watching|subscribe/i;

/**
 * whisper-1 through the relay, language zh, timed segments (the app's call shape). The relay has returned an
 * English rendering for the same Chinese audio once, so an answer that is mostly Latin letters is requested
 * again. Hallucinated segments are kept in rawSegments but left out of segments.
 */
async function transcribeVideo(video, outDir) {
  const mp3 = join(outDir, 'audio.mp3');
  await sh('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-q:a', '6', mp3]);
  const r = relay();
  const tries = [];
  let best = null;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const form = new FormData();
      form.append('file', new Blob([readFileSync(mp3)], { type: 'audio/mpeg' }), 'audio.mp3');
      form.append('model', 'whisper-1');
      form.append('language', 'zh');
      form.append('response_format', 'verbose_json');
      form.append('prompt', '以下是普通话的句子，使用简体中文和标点。');
      try {
        const res = await fetch(`${r.url}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${r.apiKey}` }, body: form, signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`whisper ${res.status} ${scrub((await res.text()).slice(0, 200))}`);
        const j = await res.json();
        const text = String(j.text ?? '').trim();
        const cjk = (text.match(/[㐀-鿿]/g) ?? []).length;
        const latin = (text.match(/[A-Za-z]/g) ?? []).length;
        best = { j, english: latin > cjk * 2 && latin > 20 };
        tries.push({ ok: true, english: best.english, chars: text.length });
        if (!best.english) break;
      } catch (e) {
        tries.push({ ok: false, error: scrub(e.message ?? e) });
      }
    }
  } finally {
    rmSync(mp3, { force: true });
  }
  if (!best) return { error: tries.at(-1)?.error ?? 'no answer', tries, segments: [], rawSegments: [], text: '' };
  const raw = (best.j.segments ?? []).map((x) => ({ start: r2(x.start), end: r2(x.end), text: String(x.text ?? '').trim(), noSpeech: r2(x.no_speech_prob ?? 0), logprob: r2(x.avg_logprob ?? 0) })).filter((x) => x.text);
  const fake = (x) => HALLUCINATION.test(x.text) || (x.noSpeech > 0.6 && x.logprob < -0.8);
  return { text: String(best.j.text ?? '').trim(), segments: raw.filter((x) => !fake(x)), rawSegments: raw, dropped: raw.filter(fake).map((x) => x.text), languageMismatch: best.english, tries, duration: best.j.duration ?? null };
}

async function buildEvidence(key) {
  const s = subject(key);
  const dir = join(VAB, key);
  rmSync(join(dir, 'frames'), { recursive: true, force: true });
  rmSync(join(dir, 'full'), { recursive: true, force: true });
  mkdirSync(join(dir, 'frames'), { recursive: true });
  mkdirSync(join(dir, 'full'), { recursive: true });
  const checks = await autoChecks(s.video, dir);
  const dur = checks.probe.duration;
  const frames = [];
  for (let t = EVERY / 2; t < dur - 0.1; t += EVERY) {
    const name = `f${String(frames.length + 1).padStart(2, '0')}`;
    frames.push({ t: r2(t), file: await extractFrame(s.video, t, join(dir, 'frames', `${name}.jpg`), { width: 480, label: `${key}  ${fmtTime(t)}` }), full: await extractFrame(s.video, t, join(dir, 'full', `${name}.png`), { width: Math.min(1280, checks.probe.width) }) });
  }
  // On-screen text: OCR of full-size frames.
  let ocr = [];
  try {
    const { stdout } = await sh(PY, ['-I', join(SC, 'ocr.py'), ...frames.map((f) => f.full)], { maxBuffer: 20 * 1024 * 1024, timeout: 20 * 60_000 });
    const byFile = new Map(stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((x) => [x.file, x.lines]));
    ocr = frames.map((f) => ({ t: f.t, lines: (byFile.get(f.full) ?? []).map((x) => x.text) }));
  } catch (e) {
    ocr = [{ error: String(e.stderr || e.message).slice(-400) }];
  }
  const transcript = await transcribeVideo(s.video, dir);
  const speechSeconds = r2((transcript.segments ?? []).filter((x) => x.noSpeech < 0.6).reduce((acc, x) => acc + (x.end - x.start), 0));
  const mains = (s.project?.shots ?? []).filter((x) => !x.role || x.role === 'main');
  const silent = {
    noTranscript: !(transcript.segments ?? []).length,
    speechShare: r2(speechSeconds / dur),
    voShots: s.project ? `${mains.filter((x) => x.voFile).length}/${mains.length}` : null,
    lowLoudness: checks.loudness ? checks.loudness.integratedLufs !== null && checks.loudness.integratedLufs < -40 : true,
  };
  // A promo cut to music with on-screen text needs no voiceover; there only a (nearly) silent video is flagged.
  silent.flag = TASK.assets ? silent.lowLoudness : Boolean(silent.noTranscript || silent.speechShare < 0.2 || (s.project && mains.length && !mains.some((x) => x.voFile)));
  const evidence = {
    key, system: s.system, stage: s.stage, video: s.video, version: s.version ?? null, builtAt: new Date().toISOString(),
    checks, silent, frames: frames.map((f) => ({ t: f.t, file: f.file })), ocr, transcript,
    script: s.script, research: s.research, conversation: s.conversation, media: s.media ?? null,
    stageInfo: s.stageInfo ? { wallSeconds: s.stageInfo.wallSeconds, secondsToVideo: s.stageInfo.secondsToVideo, userTurns: s.stageInfo.userTurns, replies: s.stageInfo.replies, costUsd: s.stageInfo.cost?.totalUsd, costByKind: s.stageInfo.cost?.byKind, firstOutputMs: s.stageInfo.firstOutputMs, maxSilentGap: s.stageInfo.maxSilentGap, shots: s.stageInfo.shots } : null,
  };
  writeJson(join(dir, 'evidence.json'), evidence);
  console.log(`${key}: ${dur}s ${checks.probe.width}x${checks.probe.height} ${checks.probe.fps}fps ${checks.probe.videoCodec}/${checks.probe.audioCodec} · I ${checks.loudness?.integratedLufs} LUFS · TLB ${checks.tlb.error ? 'error' : checks.tlb.passed ? 'pass' : 'FAIL ' + checks.tlb.failed.join(',')} · black ${checks.black.length} (${checks.blackMid.length} mid) · speech ${silent.speechShare} · silentFlag ${silent.flag} · frames ${frames.length}`);
  return evidence;
}

/* ------------------------------ judging ------------------------------ */
const METRICS = [
  ['intent_alignment', 'Intent Alignment 用户意图对齐', 25],
  ['research_grounding', 'Research & Grounding 信息收集与真实性', 15],
  ['planning_storytelling', 'Planning & Storytelling 规划与叙事', 20],
  ['visual_vfx', 'Visual & VFX Quality 视觉与特效', 15],
  ['editing_sound', 'Editing & Sound 音画编排', 15],
  ['execution_delivery', 'Execution & Delivery 执行与交付', 10],
];
const SCORE = { type: 'object', additionalProperties: false, required: ['reason', 'score'], properties: { reason: { type: 'string' }, score: { type: 'integer' } } };
const RUBRIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...METRICS.map((m) => m[0]), 'hidden_points', 'factual_errors', 'strengths', 'weaknesses'],
  properties: {
    ...Object.fromEntries(METRICS.map((m) => [m[0], SCORE])),
    hidden_points: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'evidence', 'verdict'], properties: { id: { type: 'string' }, evidence: { type: 'string' }, verdict: { type: 'string', enum: ['yes', 'partial', 'no'] } } } },
    factual_errors: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['time', 'claim', 'problem', 'severity'], properties: { time: { type: 'string' }, claim: { type: 'string' }, problem: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] } } } },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
  },
};

const RUBRIC_T1 = `你是 VideoAgentBench v0.2 的评审，按用户自己的评测标准给一条视频打分。你要像一位严格、懂科普视频制作、也懂航天的资深编辑那样判断。

任务：Task 1 DART 小行星撞击科普（建议时长 60–100 秒）。场景：普通内容创作者想做一期 B 站科学短视频，专业知识有限，需要 Agent 自行研究和表达。“用户只提出创作目标，不负责指导 Agent 如何制作视频。”

六项指标，每项 0–10 分（整数），总分按权重折算到 100 分：
1. intent_alignment（25）：成片是否回答了用户的真实问题（“是不是真的把轨道撞歪了”）；是否理解“一分钟多点、发 B 站、有点电影感、别搞成世界末日、别像上课一样无聊、没学过航天的人也能看明白”；是否补全必要但未明说的工作；有无过度执行、错误推断、偏题。不能因为没有采用评审偏好的镜头设计就扣分。
2. research_grounding（15）：是否知道哪些信息需要外部验证并用了可靠来源（NASA、ESA、JHU APL、同行评审论文）；事实与数字是否正确；是否区分事实、推断与虚构（真实观测影像、模拟动画、艺术化镜头是否区分或标注）；有无编造。对没有工具日志的系统，根据成片内容的准确性与具体程度、以及对话里表现出的研究过程判断，不要仅因缺日志扣分，但要说明不确定性。
3. planning_storytelling（20）：结构和信息层次是否清楚；镜头是否有叙事作用；是否适合目标受众；时长与节奏控制；是否体现整体规划而不是片段拼接。
4. visual_vfx（15）：主体、场景、风格的一致性；动画、合成、转场的技术完成度；空间动画是否有效解释抽象概念（例如双小行星绕转、轨道周期变化）；有无不自然运动、变形、空间关系错误；有无为炫技牺牲目标。
5. editing_sound（15）：镜头衔接与时空连续性；旁白、音乐、音效是否支撑叙事；字幕与画面文字的准确性和可读性；节奏；有无突兀剪辑、音频断裂、严重不同步、长时间无声。成片没有旁白或长时间静音是严重缺陷。
6. execution_delivery（10）：是否自主完成必要步骤；是否合理调用工具并处理失败；是否交付可播放的完整视频；有无明显技术错误或缺失；成本与耗时是否合理。交付失败必须明确记录，不能被其他指标的高分抵消。

评分锚点：9–10 专业水准、几乎无可挑剔；7–8 良好，有小问题；5–6 及格但有明显问题；3–4 较差；0–2 失败或缺失。请严格，不要因为整体观感好就把每项都打高分。

评测者的隐藏关注点（逐条判断 yes/partial/no 并给出证据，id 用 H1…H7）：
${TASK.hidden.map((h, i) => `H${i + 1}. ${h}`).join('\n')}

关于 DART 的已知事实（供核对，不是要求视频全部讲到）：DART 于 2021 年 11 月发射，2022 年 9 月 26 日（美国东部时间，北京时间为 9 月 27 日）撞击双小行星系统 Didymos 的小卫星 Dimorphos（直径约 160 米，主星 Didymos 约 780 米），撞击速度约 6.1 km/s，航天器约 500–600 公斤。撞击使 Dimorphos 绕 Didymos 的公转周期从约 11 小时 55 分缩短了约 32–33 分钟（NASA 最初公布 32 分钟，误差约 ±2 分钟），远超成功标准的 73 秒；大量喷出物带来的反冲使动量传递效率 β 约为 3.6（约 2.2–4.9）。改变的是小卫星绕主星的轨道，不是让整个双小行星系统绕太阳的日心轨道发生显著改变（日心轨道变化极其微小：后续研究估计整个系统的绕日周期只变化了零点几秒；视频若引用更新的研究或数字，只要量级合理，不要仅因年份或来源不同就判为错误）。Didymos 系统对地球没有威胁，这是一次行星防御技术验证。意大利航天局的 LICIACube 立方星拍到了撞击后的喷出物；ESA 的 Hera 任务 2024 年 10 月发射，预计 2026 年底抵达进行详细勘测。

证据说明：给你的是按时间每隔几秒的抽帧（图片上方黑条是标签，不属于视频）、语音转写（whisper，可能有个别错字）、画面文字 OCR（可能有识别错误）、剧本与镜头表（如有）、检索记录（如有）、对话过程与交付情况、自动检测结果。抽帧之间的动作看不到，不要对看不到的内容扣分，但要对看得到的问题扣分。
先写理由（指出最重要的具体问题和亮点，引用时间点和原话），再给分。所有理由用中文，每条一两句。`;

const storeProfile = () => (TASK.assets && existsSync(join(TASK.assets, 'store_profile.md')) ? readFileSync(join(TASK.assets, 'store_profile.md'), 'utf8').trim() : '');
const RUBRIC_T2 = () => `你是 VideoAgentBench v0.2 的评审，按用户自己的评测标准给一条视频打分。你要像一位严格、懂抖音短视频、也懂小店宣传的资深剪辑师那样判断。

任务：Task 2 Coffee Launch 独立咖啡店宣传视频（建议时长 ${TASK.suggestedSeconds} 秒，抖音竖屏 9:16）。场景：小型实体商家希望用已有的手机拍摄素材做一条社交媒体宣传片；用户没有影视制作知识，对视觉风格只有主观描述。素材包由评测方提供：店铺资料（store_profile.md）、黑板菜单图、Logo、5 张照片、18 段竖屏手机视频（带现场声），其中部分素材有抖动、重复拍摄、曝光问题或无效内容。“用户只提出创作目标，不负责指导 Agent 如何制作视频。”

六项指标，每项 0–10 分（整数），总分按权重折算到 100 分：
1. intent_alignment（25）：是否理解“能发抖音的宣传视频、有质感、看着很舒服、不要太像硬广、让人看了想来店里坐坐、不用太长”；成片是否真的让人想来店里坐坐；是否补全必要但没明说的工作（例如让观众知道店名、在哪、什么时候开业）；有无过度执行、错误推断、偏题。不能因为没有采用评审偏好的镜头设计就扣分。
2. research_grounding（15）：本任务的重点是正确理解并使用提供的商家资料：店名、地址、开业日期、营业时间、价格、优惠、人物等信息是否与店铺资料一致；有无编造资料里没有的价格、优惠、营业时间、产品或事实；画面与说法是否对得上（说的东西画面里确实是）；是否用对了店铺的定位和说话方式。
3. planning_storytelling（20）：是否构建了合理的宣传叙事，而不是素材的简单拼接；镜头是否有叙事作用；是否符合抖音的观看习惯（前几秒抓人、信息层次清楚）；时长与节奏控制。
4. visual_vfx（15）：选用镜头的画质（有没有用到抖动、过曝、重复或无效的素材）；调色是否统一、有质感；文字动效和包装的完成度；主体与风格一致；有无变形、黑边、裁切不当、画面跳变。
5. editing_sound（15）：镜头衔接与节奏是否舒服、是否跟音乐走；音乐、现场声、旁白是否支撑氛围；字幕与画面文字的准确性和可读性；有无突兀剪辑、音频断裂、严重不同步、长时间无声。宣传片可以没有旁白（音乐加字卡也行），但成片几乎没有声音是严重缺陷。
6. execution_delivery（10）：是否自主完成必要步骤；是否合理调用工具并处理失败；是否交付可播放的完整视频；有无明显技术错误或缺失；成本与耗时是否合理。交付失败必须明确记录，不能被其他指标的高分抵消。

评分锚点：9–10 专业水准、几乎无可挑剔；7–8 良好，有小问题；5–6 及格但有明显问题；3–4 较差；0–2 失败或缺失。请严格，不要因为整体观感好就把每项都打高分。

评测者的隐藏关注点（逐条判断 yes/partial/no 并给出证据，id 用 H1…H${TASK.hidden.length}）：
${TASK.hidden.map((h, i) => `H${i + 1}. ${h}`).join('\n')}

店铺资料原文（Agent 也拿到了这份，所有事实以它为准）：
${storeProfile()}

评测方资料（Agent 看不到，只供你核对）：
- 有缺陷的素材：${(PACK?.defective_clips ?? []).map((d) => `${d.file.split('/').pop()}（${d.defect}）：${d.note}`).join('；')}
${PACK?.facts_must_not_be_invented ? `- 不能编造的信息：${JSON.stringify(PACK.facts_must_not_be_invented)}\n` : ''}${PACK?.known_limits_of_the_footage ? `- 素材本身的局限（不要因此扣 Agent 的分）：${JSON.stringify(PACK.known_limits_of_the_footage)}\n` : ''}
证据说明：给你的是按时间每隔几秒的抽帧（图片上方黑条是标签，不属于视频）、语音转写（whisper，可能有个别错字）、画面文字 OCR（可能有识别错误）、剧本与镜头表（含每个镜头用的是哪段原始素材）、用户素材与入库结果、对话过程与交付情况、自动检测结果。抽帧之间的动作看不到，不要对看不到的内容扣分，但要对看得到的问题扣分。
先写理由（指出最重要的具体问题和亮点，引用时间点和原话），再给分。所有理由用中文，每条一两句。`;
const RUBRIC_SYSTEM = TASK.id === 'vab-t2' ? RUBRIC_T2() : RUBRIC_T1;

function evidenceBlocks(ev, { label = '' } = {}) {
  const c = ev.checks;
  const text = [
    `${label}【自动检测】时长 ${c.probe.duration}s，${c.probe.width}x${c.probe.height}，${c.probe.fps}fps，视频 ${c.probe.videoCodec}，音频 ${c.probe.audioCodec ?? '无音轨'}；响度 ${c.loudness ? `${c.loudness.integratedLufs} LUFS（LRA ${c.loudness.lraLu} LU，峰值 ${c.loudness.truePeakDbtp} dBTP）` : '无音轨'}；` +
      `内容守卫 ${c.tlb.error ? '运行出错' : c.tlb.passed ? '全部通过' : `未通过 ${c.tlb.failed.join('、')}`}（${Object.entries(c.tlb.values ?? {}).map(([k, v]) => `${k}=${v}`).join('，')}）；全黑帧（最亮像素也接近黑）${c.strictBlack?.length ?? '未测'} 段${c.strictBlack?.length ? '：' + c.strictBlack.map((b) => `${b.start.toFixed(2)}–${(b.end + 1 / (c.probe.fps || 24)).toFixed(2)}s（${b.frames} 帧）`).join('，') : ''}（blackdetect 宽松阈值把深色太空画面也算作黑，${c.black.length} 段，仅供参考）；` +
      `语音占比 ${ev.silent.speechShare}${ev.silent.voShots ? `，带配音的主镜头 ${ev.silent.voShots}` : ''}${ev.silent.flag ? (TASK.assets ? '。⚠ 几乎没有声音' : '。⚠ 疑似没有旁白/静音成片') : ''}。`,
    `${label}【语音转写】${ev.transcript.languageMismatch ? '（注意：转写服务这次返回的是英文译文，不代表视频里说的是英文）' : ''}${ev.transcript.dropped?.length ? `（已去掉 whisper 在无人声处常见的幻觉句 ${ev.transcript.dropped.length} 条，例如“${ev.transcript.dropped[0]}”，这些不是视频里的话）` : ''}\n${ev.transcript.segments?.length ? ev.transcript.segments.map((s) => `[${fmtTime(s.start)}–${fmtTime(s.end)}] ${s.text}`).join('\n') : `（没有识别到人声旁白${ev.transcript.error ? '，转写出错：' + ev.transcript.error : ''}）`}`,
    `${label}【画面文字 OCR】${ev.ocr.filter((o) => o.lines?.length).map((o) => `[${fmtTime(o.t)}] ${o.lines.join(' / ')}`).join('\n') || '（没有识别到文字）'}`,
    ev.script ? `${label}【剧本与镜头表】\n${ev.script}` : `${label}【剧本与镜头表】（黑盒系统，没有）`,
    ...(ev.media ? [`${label}【用户素材与入库结果】（Agent 能看到的入库标记；★ 为这一版用到的素材）\n${ev.media}`] : []),
    ev.research ? `${label}【检索记录】${ev.research.length ? ev.research.map((r, i) => `${i + 1}. 查询：${r.query}\n   结果摘要：${(r.findings ?? '').replace(/\s+/g, ' ').slice(0, 700)}\n   来源：${(r.sources ?? []).map((s) => `${s.title} ${s.url}`).join('；') || '无'}`).join('\n') : '（没有调用检索）'}` : `${label}【检索记录】（黑盒系统，没有工具日志）`,
    `${label}【对话过程与交付】\n${ev.conversation}${ev.stageInfo ? `\n（本阶段用时 ${ev.stageInfo.wallSeconds}s，到出片 ${ev.stageInfo.secondsToVideo}s，用户消息 ${ev.stageInfo.userTurns} 条，应用估算成本 $${ev.stageInfo.costUsd}）` : ''}`,
  ].join('\n\n');
  return text;
}

function framesContent(ev, label, kind) {
  const out = [];
  for (const f of ev.frames) {
    const data = readFileSync(f.file).toString('base64');
    out.push(kind === 'claude' ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } } : { inline_data: { mime_type: 'image/jpeg', data } });
  }
  const head = `${label}【抽帧】每 ${EVERY} 秒一帧，共 ${ev.frames.length} 帧，按时间顺序：`;
  return [kind === 'claude' ? { type: 'text', text: head } : { text: head }, ...out];
}

function weighted(metrics) {
  if (!METRICS.every(([m]) => typeof metrics[m] === 'number')) return null;
  return r2(METRICS.reduce((a, [m, , w]) => a + (metrics[m] * w) / 10, 0));
}

function aggregate(name, results, keys, extra) {
  const samples = results.map((r, i) => {
    if (!r.ok) return { ok: false, attempts: r.attempts ?? r.tried, rejected: r.rejected };
    const metrics = Object.fromEntries(keys.map((k) => [k, typeof r.data?.[k]?.score === 'number' ? Math.max(0, Math.min(10, r.data[k].score)) : null]));
    return { ok: true, model: r.model, metrics, reasons: Object.fromEntries(keys.map((k) => [k, r.data?.[k]?.reason ?? ''])), data: r.data, usd: r.usd ?? null, ms: r.ms, rejectedBefore: r.rejected?.length ?? 0, ...(extra ? extra(metrics) : {}) };
  });
  const ok = samples.filter((x) => x.ok);
  if (!ok.length) return { judge: name, ok: false, samples };
  const mean = (xs) => r2(xs.reduce((a, b) => a + b, 0) / xs.length);
  const metrics = Object.fromEntries(keys.map((k) => { const v = ok.map((x) => x.metrics[k]).filter((x) => typeof x === 'number'); return [k, { value: v.length ? mean(v) : null, samples: v, reason: ok[0].reasons[k] }]; }));
  const out = { judge: name, ok: true, model: ok[0].model, k: samples.length, okSamples: ok.length, metrics, samples };
  if (extra) {
    const totals = ok.map((x) => x.total).filter((x) => typeof x === 'number');
    Object.assign(out, { total: totals.length ? mean(totals) : null, totalSamples: totals, spread: totals.length > 1 ? r2(Math.max(...totals) - Math.min(...totals)) : 0 });
  }
  return out;
}

/**
 * A judge answer counts only when every scored field has a real reason and the checklists are complete; the
 * relay's structured output has returned half-empty objects (score 0, reason "") at least once.
 */
function validFor(keys, listKey, listMin) {
  return (r) => r.ok && keys.every((k) => typeof r.data?.[k]?.score === 'number' && String(r.data[k].reason ?? '').trim().length >= 10)
    && (!listKey || (Array.isArray(r.data?.[listKey]) && r.data[listKey].length >= listMin));
}

async function validated(call, isValid, tries = 3) {
  const rejected = [];
  for (let i = 0; i < tries; i++) {
    const r = await call();
    if (isValid(r)) return { ...r, rejected };
    rejected.push({ ok: r.ok, reason: r.ok ? 'incomplete answer' : 'call failed', attempts: r.attempts ?? r.tried, head: r.raw ? String(r.raw).slice(0, 200) : undefined });
  }
  return { ok: false, rejected, attempts: rejected };
}

async function runJudges(system, claudeContent, geminiParts, schema, isValid) {
  const times = (f) => Array.from({ length: K }, f);
  const extra = ONLY ? '' : (process.env.VEVAL_EXTRA_JUDGE ?? '').trim();
  const callA = () => (JUDGE_A_CHANNEL === 'relay'
    ? claudeJson({ model: 'claude-opus-5-5', system, content: claudeContent, schema, effort: process.env.VEVAL_JUDGE_EFFORT ?? 'high', maxTokens: 32000 })
    : claudeJsonCC({ model: 'claude-opus-5-5', system, content: claudeContent, schema, effort: process.env.VEVAL_JUDGE_EFFORT ?? 'high' }));
  const [a, b, c] = await Promise.all([
    !ONLY || ONLY === 'A' ? Promise.all(times(() => validated(callA, isValid))) : Promise.resolve(null),
    !ONLY || ONLY === 'B' ? Promise.all(times(() => validated(() => geminiJson({ models: GEMINI, system, parts: geminiParts }), isValid))) : Promise.resolve(null),
    extra ? Promise.all(times(() => validated(() => geminiJson({ models: [extra], system, parts: geminiParts }), isValid))) : Promise.resolve(null),
  ]);
  return { a, b, c, extra };
}

/** With --only A|B the other judges' earlier results are kept; a replaced Judge A is kept as judgeA_<old channel>. */
function mergeOnly(file, fresh) {
  const old = readJson(file, null);
  if (!ONLY || !old) return fresh;
  const out = { ...old, judgedAt: fresh.judgedAt };
  if (ONLY === 'A') {
    if (old.judgeA && (old.judgeA.channel ?? 'relay') !== fresh.judgeA.channel) out[`judgeA_${old.judgeA.channel ?? 'relay'}`] = old.judgeA;
    out.judgeA = fresh.judgeA;
  }
  if (ONLY === 'B') out.judgeB = fresh.judgeB;
  return out;
}

async function judge(key) {
  const evFile = join(VAB, key, 'evidence.json');
  const ev = existsSync(evFile) ? readJson(evFile) : await buildEvidence(key);
  const intro = `用户第一轮的原话：\n「${TASK.prompt}」\n\n${ev.stage === 'B' ? `这是修改后的第二版（Stage B）。第二轮用户反馈：「${TASK.revision}」。请按同一套六项标准评价这一版成片本身（修改效果另有单独评审）。\n\n` : ''}下面是这条成片的证据。`;
  const body = evidenceBlocks(ev);
  const claudeContent = [{ type: 'text', text: `${intro}\n\n${body}` }, ...framesContent(ev, '', 'claude'), { type: 'text', text: '请按系统说明输出 JSON：六项指标（理由在前、分数在后）、H1–H7 隐藏关注点、事实错误、主要优点和主要问题（各 3–5 条，引用时间点）。' }];
  const geminiParts = [{ text: `${intro}\n\n${body}` }, ...framesContent(ev, '', 'gemini'), { text: `请按系统说明输出 JSON，结构必须符合这个 JSON Schema：\n${JSON.stringify(RUBRIC_SCHEMA)}` }];
  console.log(`${key}: judging with ${K} samples per judge...`);
  const keys = METRICS.map((m) => m[0]);
  const { a, b, c, extra: extraModel } = await runJudges(RUBRIC_SYSTEM, claudeContent, geminiParts, RUBRIC_SCHEMA, validFor(keys, 'hidden_points', TASK.hidden.length));
  const extra = (metrics) => ({ total: weighted(metrics) });
  const judgeA = a ? { ...aggregate('A', a, keys, extra), channel: JUDGE_A_CHANNEL } : null;
  const judgeB = b ? aggregate('B', b, keys, extra) : null;
  const judgeC = c ? { ...aggregate(`C:${extraModel}`, c, keys, extra), requested: extraModel } : null;
  const file = join(VAB, key, 'scores.json');
  const out = mergeOnly(file, { key, system: ev.system, stage: ev.stage, video: ev.video, judgedAt: new Date().toISOString(), samplesPerJudge: K, weights: Object.fromEntries(METRICS.map((m) => [m[0], m[2]])), judgeA, judgeB, judgeC });
  writeJson(file, out);
  const line = (j) => (j.ok ? `${j.model} total ${j.total} (${j.totalSamples.join('/')}) | ${keys.map((k) => `${k.split('_')[0]} ${j.metrics[k].value}`).join(' ')}` : `failed ${JSON.stringify(j.samples.map((x) => x.attempts)).slice(0, 400)}`);
  console.log([judgeA && `A ${line(judgeA)} [${JUDGE_A_CHANNEL}]`, judgeB && `B ${line(judgeB)}`, judgeC && `C ${line(judgeC)}`].filter(Boolean).join('\n'));
}

/* ------------------------------ revision ------------------------------ */
const REV_T1 = [
  ['revision_compliance', 'Revision Compliance：是否真正解决用户提出的问题（开头营销号感；中间轨道变化没看懂）'],
  ['content_preservation', 'Content Preservation：是否保留不需要修改的有效内容（用户说其他部分还行）'],
  ['quality_improvement', 'Quality Improvement：修改后的总体质量是否提升'],
];
const REV = REV_T1;
// The two yes/partial/no checks of each task's revision: Task 1 opening + orbit, Task 2 warmth + coffee making kept.
const REV_CHECKS = TASK.id === 'vab-t2' ? ['warmer', 'coffee_kept'] : ['opening_fixed', 'orbit_clearer'];
const VERDICT = { type: 'object', additionalProperties: false, required: ['evidence', 'verdict'], properties: { evidence: { type: 'string' }, verdict: { type: 'string', enum: ['yes', 'partial', 'no'] } } };
const REV_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [...REV.map((m) => m[0]), ...REV_CHECKS, 'unnecessary_changes', 'regressions'],
  properties: {
    ...Object.fromEntries(REV.map((m) => [m[0], SCORE])),
    ...Object.fromEntries(REV_CHECKS.map((k) => [k, VERDICT])),
    unnecessary_changes: { type: 'array', items: { type: 'string' } },
    regressions: { type: 'array', items: { type: 'string' } },
  },
};
const REV_SYSTEM_T1 = `你是 VideoAgentBench v0.2 的评审，评价 Task 1（DART 小行星撞击科普）第二阶段的修改效果。第一版交付后，用户的反馈是：
「${TASK.revision}」
评测意图：${TASK.revisionIntent}

请比较第一版（v1）和修改版（v2），给三项打 0–10 分（整数）：
1. revision_compliance：是否真正解决了用户提出的两个问题——开头的“营销号”感（标题党、夸张、震惊体、制造悬念或危机感的话术）是否去掉，中间“轨道变化”是否讲明白了（尤其是绕主星的公转周期缩短 vs 日心轨道几乎不变，是否有清楚的空间动画或类比）。
2. content_preservation：用户说“其他部分我觉得还行”，不需要改的有效内容是否保留；有没有不必要的重做、换掉原来好的镜头、改动无关的旁白。
3. quality_improvement：修改后整体质量（准确性、可懂度、观感、节奏）是否提升，有无新的退步。
同时判断：opening_fixed（开头问题是否解决）、orbit_clearer（轨道变化是否更好懂），列出不必要的改动和退步。
评分锚点：9–10 完全解决且精准，几乎无副作用；7–8 基本解决，小问题；5–6 部分解决；3–4 基本没解决或副作用大；0–2 没有修改或改坏。不得因为“整条重新生成”就给高分，应根据修改范围和结果评价针对性和效率。
证据包括两版的抽帧、语音转写、画面文字、剧本与镜头表，以及两版之间镜头复用的统计、第二阶段的对话、耗时与成本。先写理由（引用时间点和原话），再给分。所有理由用中文。`;
const REV_SYSTEM_T2 = () => `你是 VideoAgentBench v0.2 的评审，评价 Task 2（独立咖啡店抖音宣传片）第二阶段的修改效果。第一版交付后，用户的反馈是：
「${TASK.revision}」
评测意图：${TASK.revisionIntent}
评测方提示（Agent 看不到）：${(PACK?.revision?.evaluator_hints ?? []).join(' ')}

请比较第一版（v1）和修改版（v2），给三项打 0–10 分（整数）：
1. revision_compliance：是否真正把“太精致、像大品牌广告、不像小店”“更有人情味”转成了具体修改——例如减弱商业化的调色、字效和配乐，多用店主、邻居、顾客的生活化镜头，说话方式更像街坊邻居；而不是只换了个滤镜。
2. content_preservation：用户说喜欢咖啡制作的部分、尽量保留：这部分是否保留（镜头、顺序和节奏大体不变）；有没有不必要的整条重做、换掉原来好的镜头、改动无关的内容。
3. quality_improvement：修改后整体质量（观感、节奏、信息准确、让人想来店里）是否提升，有无新的退步（例如编造信息、用了有缺陷的素材、变长或变拖）。
同时判断：warmer（是否明显更有人情味、更像小店）、coffee_kept（咖啡制作部分是否保留），列出不必要的改动和退步。
评分锚点：9–10 完全解决且精准，几乎无副作用；7–8 基本解决，小问题；5–6 部分解决；3–4 基本没解决或副作用大；0–2 没有修改或改坏。不得因为“整条重新做”就给高分，应根据修改范围和结果评价针对性和效率。
证据包括两版的抽帧、语音转写、画面文字、剧本与镜头表（含每个镜头用的原始素材），以及两版之间镜头复用的统计、第二阶段的对话、耗时与成本。先写理由（引用时间点和原话），再给分。所有理由用中文。`;
const REV_SYSTEM = TASK.id === 'vab-t2' ? REV_SYSTEM_T2() : REV_SYSTEM_T1;

function shotDiff(run, v1, v2) {
  const dir = sessionDir(run.sessionId);
  const p = readJson(join(dir, 'project.json'));
  const rec = (n) => p.versions.find((x) => x.n === n);
  const a = rec(v1), b = rec(v2);
  if (!a || !b) return null;
  const hashesA = new Map(a.shots.map((s) => [s.inputHash, s]));
  const idsA = new Set(a.shots.map((s) => s.id));
  const reused = b.shots.filter((s) => s.inputHash && hashesA.has(s.inputHash));
  const changed = b.shots.filter((s) => idsA.has(s.id) && !hashesA.has(s.inputHash));
  const added = b.shots.filter((s) => !idsA.has(s.id) && !hashesA.has(s.inputHash));
  const removed = a.shots.filter((s) => !b.shots.some((x) => x.id === s.id || x.inputHash === s.inputHash));
  const snap1 = readJson(join(dir, `versions/v${v1}.project.json`), null);
  const snap2 = readJson(join(dir, `versions/v${v2}.project.json`), null);
  const vo = (snap) => new Map((snap?.shots ?? []).map((s) => [s.id, s.vo ?? '']));
  const vo1 = vo(snap1), vo2 = vo(snap2);
  const voChanged = [...vo2.entries()].filter(([id, line]) => vo1.has(id) && vo1.get(id) !== line).map(([id]) => id);
  return {
    v1: { shots: a.shots.length, seconds: a.seconds }, v2: { shots: b.shots.length, seconds: b.seconds },
    reused: reused.map((s) => `${s.id}(${s.kind})`), changed: changed.map((s) => `${s.id}(${s.kind})`), added: added.map((s) => `${s.id}(${s.kind})`), removed: removed.map((s) => `${s.id}(${s.kind})`),
    voChanged, reusedShare: r2(reused.length / b.shots.length),
    seedanceRegenerated: [...changed, ...added].filter((s) => s.kind === 'seedance').length,
  };
}

async function revise(runName) {
  const e1 = readJson(join(VAB, `${runName}-v1`, 'evidence.json'));
  const e2 = readJson(join(VAB, `${runName}-v2`, 'evidence.json'));
  const run = readJson(join(P.runs, `${TASK.id}-${runName}.json`));
  const diff = shotDiff(run, e1.version, e2.version);
  const stB = run.stages[1];
  const stats = `【两版对比统计】v1 第 ${e1.version} 版 ${e1.checks.probe.duration}s，v2 第 ${e2.version} 版 ${e2.checks.probe.duration}s。` +
    (diff ? `v2 共 ${diff.v2.shots} 个镜头：原样复用 ${diff.reused.length} 个（${diff.reused.join('、') || '无'}），同 id 重做 ${diff.changed.length} 个（${diff.changed.join('、') || '无'}），新增 ${diff.added.length} 个（${diff.added.join('、') || '无'}），删除 ${diff.removed.length} 个（${diff.removed.join('、') || '无'}）；口播改动的镜头：${diff.voChanged.join('、') || '无'}；重新生成的写实镜头 ${diff.seedanceRegenerated} 个。` : '') +
    `第二阶段用时 ${stB.wallSeconds}s，用户消息 ${stB.userTurns} 条，应用估算成本 $${stB.cost?.totalUsd}。`;
  const intro = `第一轮用户原话：「${TASK.prompt}」\n\n${stats}`;
  const claudeContent = [
    { type: 'text', text: `${intro}\n\n===== 第一版 v1 =====\n${evidenceBlocks(e1, { label: 'v1 ' })}` }, ...framesContent(e1, 'v1 ', 'claude'),
    { type: 'text', text: `===== 修改版 v2 =====\n${evidenceBlocks(e2, { label: 'v2 ' })}` }, ...framesContent(e2, 'v2 ', 'claude'),
    { type: 'text', text: '请按系统说明输出 JSON（理由在前，分数在后）。' },
  ];
  const geminiParts = [
    { text: `${intro}\n\n===== 第一版 v1 =====\n${evidenceBlocks(e1, { label: 'v1 ' })}` }, ...framesContent(e1, 'v1 ', 'gemini'),
    { text: `===== 修改版 v2 =====\n${evidenceBlocks(e2, { label: 'v2 ' })}` }, ...framesContent(e2, 'v2 ', 'gemini'),
    { text: `请按系统说明输出 JSON，结构必须符合这个 JSON Schema：\n${JSON.stringify(REV_SCHEMA)}` },
  ];
  console.log(`${runName}: revision judging with ${K} samples per judge...`);
  const keys = REV.map((m) => m[0]);
  const isValid = (r) => validFor(keys)(r) && REV_CHECKS.every((k) => ['yes', 'partial', 'no'].includes(r.data?.[k]?.verdict));
  const { a, b, c, extra: extraModel } = await runJudges(REV_SYSTEM, claudeContent, geminiParts, REV_SCHEMA, isValid);
  const judgeA = a ? { ...aggregate('A', a, keys), channel: JUDGE_A_CHANNEL } : null;
  const judgeB = b ? aggregate('B', b, keys) : null;
  const judgeC = c ? { ...aggregate(`C:${extraModel}`, c, keys), requested: extraModel } : null;
  const file = join(VAB, `${runName}-revision.json`);
  writeJson(file, mergeOnly(file, { run: runName, judgedAt: new Date().toISOString(), samplesPerJudge: K, diff, stageB: { wallSeconds: stB.wallSeconds, userTurns: stB.userTurns, replies: stB.replies, costUsd: stB.cost?.totalUsd, costByKind: stB.cost?.byKind }, judgeA, judgeB, judgeC }));
  const line = (j) => (j.ok ? `${j.model} | ${keys.map((k) => `${k} ${j.metrics[k].value} (${j.metrics[k].samples.join('/')})`).join(' ')}` : 'failed');
  console.log([judgeA && `A ${line(judgeA)} [${JUDGE_A_CHANNEL}]`, judgeB && `B ${line(judgeB)}`, judgeC && `C ${line(judgeC)}`].filter(Boolean).join('\n'));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'evidence') await buildEvidence(arg);
else if (cmd === 'judge') await judge(arg);
else if (cmd === 'revise') await revise(arg);
else {
  console.error('usage: vab-eval.mjs evidence|judge <subject> | revise <runN>');
  process.exit(2);
}
