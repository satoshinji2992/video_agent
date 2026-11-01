// Drives one topic through the running app over HTTP, acting as a cooperative but lazy user, and logs
// everything to runs/<runName>.json (runName defaults to the topic id).
//
// Usage: BASE=http://127.0.0.1:8790 node driver.mjs <topicId> [runName]
// Tasks with a `revision` prompt (vab-tasks.json) run in two stages in the same session: stage A sends the
// prompt and drives until a video is delivered; stage B then sends the revision prompt and drives until a newer
// version is delivered. Turn and time limits apply per stage.
// Env: BASE (app URL), VEVAL_DATA_DIR (the app's DATA_DIR, default ./data), MAX_MINUTES (60), MAX_TURNS (6),
//      IDLE_NUDGE_SECONDS (300).
//
// The user model is deliberately generic (it reacts to what is on screen, not to a known flow):
//  - a question card (ask, mode != "suggest")  -> click the recommended option (text + answer {id, index});
//  - a script card and no question card        -> "可以，按这个做";
//  - a turn that ended in an error              -> "继续";
//  - the bot's last message is a question       -> "面向普通观众就行，时长你定，直接做吧";
//  - nothing to answer: wait while the session reports background work; if nothing at all happens for
//    IDLE_NUDGE_SECONDS and the session is idle, send the plain reply once more as a nudge.
//  - approval cards (paid redo etc.) are allowed.
// Stops after a video plus the turn_end that follows it (or a grace period when the video arrives outside a
// turn), after MAX_MINUTES, or when MAX_TURNS user messages have been sent and the last one is answered.
// Tasks with `assets` (a folder) upload every file in it first, the way the web UI does (one batch, two at a time,
// chunked, names relative to the folder), and send the stage A prompt with the media ids attached.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, DATA_DIR, ledgerFor, P, probeDuration, readJson, sessionDir, topicById, writeJson } from './lib.mjs';

const topicId = process.argv[2];
if (!topicId) {
  console.error('usage: node driver.mjs <topicId> [runName]');
  process.exit(2);
}
const topic = topicById(topicId);
const runName = process.argv[3] ?? topicId;
const STAGES = [{ name: 'A', prompt: topic.prompt }, ...(topic.revision ? [{ name: 'B', prompt: topic.revision }] : [])];
const MAX_MS = Number(process.env.MAX_MINUTES ?? 60) * 60_000;
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 6);
const IDLE_NUDGE_MS = Number(process.env.IDLE_NUDGE_SECONDS ?? 300) * 1000;
const VIDEO_GRACE_MS = 120_000;
const REPLY_PLAIN = '面向普通观众就行，时长你定，直接做吧';
const REPLY_SCRIPT = '可以，按这个做';
const REPLY_RETRY = '继续';
const OUT = join(P.runs, `${runName}.json`);

const T0 = Date.now();
const rel = () => Date.now() - T0;
const secs = (ms) => Math.round(ms / 100) / 10;
const log = (...a) => console.log(`${String(secs(rel())).padStart(7)}s`, ...a);

const run = {
  harness: 'veval driver v2', topic, runName, base: BASE, dataDir: DATA_DIR, sessionId: null,
  startedAt: new Date(T0).toISOString(), endedAt: null, inProgress: true, stopReason: null,
  limits: { maxMinutesPerStage: MAX_MS / 60_000, maxTurnsPerStage: MAX_TURNS, idleNudgeSeconds: IDLE_NUDGE_MS / 1000 },
  predefinedReplies: { plainQuestion: REPLY_PLAIN, scriptCard: REPLY_SCRIPT, turnError: REPLY_RETRY, askCard: 'the recommended option of the card (first option when none is recommended)' },
  turns: [], decisions: [], errors: [], events: [],
};

/* ------------------------------ state ------------------------------ */
let sid = null;
let finished = false;
let sending = false;
let turnRunning = false;
let lastEventAt = Date.now();
let video = null; // last video event {version, url, seconds, t}
let videoTurnEnded = false; // a turn_end arrived after the current stage's video
let stageIdx = 0;
const stageState = STAGES.map((x) => ({ name: x.name, prompt: x.prompt, startT: null, endT: null, videoMin: 1, video: null }));
const stage = () => stageState[stageIdx];
const stageTurns = () => run.turns.filter((t) => t.stage === stage().name).length;
let lastTurnEnd = null;
/** What the bot showed since the last user message. */
let since = { ask: null, script: false, lastBubble: null, lastVisibleType: null };
const visible = []; // {t, type, label} bot outputs that count as visible (spec list)
const progress = []; // {t, type} stage/activity/note/research/shot_status: progress indicators
const anchors = []; // {t} user sends
const seen = new Set();
let lastTs = 0;
let readyShots = new Set();
let planIds = '';
let planSeen = false;
const failedShots = new Map();
let lastCost = null;

const curTurn = () => run.turns.at(-1);

function noteVisible(type, label, t = rel()) {
  visible.push({ t, type, label });
  since.lastVisibleType = type;
  const turn = curTurn();
  if (turn && turn.firstVisible === null && t >= turn.sentAt) turn.firstVisible = { ms: t - turn.sentAt, type };
}

function firstOutput(type, t = rel()) {
  const turn = curTurn();
  if (turn && turn.firstVisible === null && t >= turn.sentAt) turn.firstVisible = { ms: t - turn.sentAt, type };
}

/* ------------------------------ events ------------------------------ */
function onEvent(e) {
  const key = `${e.type}:${e.ts ?? ''}:${e.id ?? ''}:${e.type === 'delta' ? e.text : ''}`;
  if (e.type !== 'replay') {
    if (seen.has(key)) return;
    seen.add(key);
    if (typeof e.ts === 'number') lastTs = Math.max(lastTs, e.ts);
  }
  // The server stamps every event (ts, same machine clock); replayed events keep their original time.
  const t = typeof e.ts === 'number' ? Math.max(0, e.ts - T0) : rel();
  lastEventAt = Date.now();
  run.events.push({ t, at: new Date(T0 + t).toISOString(), ...(e.type === 'replay' ? { type: 'replay', count: (e.events ?? []).length, busy: e.busy } : e) });
  const turn = curTurn();
  switch (e.type) {
    case 'replay':
      // On a reconnect the server replays its history: handle only what we have not seen.
      for (const old of e.events ?? []) if ((old.ts ?? 0) > lastTs - 1) onEvent(old);
      return;
    case 'turn_start':
      turnRunning = true;
      return;
    case 'delta':
      firstOutput('delta', t);
      return;
    case 'bubble_end':
      since.lastBubble = String(e.text ?? '');
      turn?.botTexts.push({ t, text: since.lastBubble });
      noteVisible('bubble', since.lastBubble.slice(0, 40), t);
      log('Bot:', since.lastBubble);
      if (!turnRunning) debounceDecide('bubble outside a turn');
      return;
    case 'script':
      since.script = true;
      turn?.cards.push({ t, type: 'script', version: e.version, segments: (e.segments ?? []).length, total_seconds: e.total_seconds });
      noteVisible('script', `v${e.version} ${(e.segments ?? []).length} segments ${e.total_seconds}s`, t);
      log(`[script card v${e.version}] ${e.title} · ${e.total_seconds}s ${e.aspect} · ${(e.segments ?? []).length} segments`);
      return;
    case 'ask':
      turn?.cards.push({ t, type: 'ask', mode: e.mode, question: e.question, options: e.options, recommended: e.recommended });
      noteVisible(e.mode === 'suggest' ? 'suggest' : 'ask', e.question, t);
      log(`[ask${e.mode === 'suggest' ? '/suggest' : ''}] ${e.question} :: ${(e.options ?? []).map((o, i) => `${i === e.recommended ? '*' : ''}${o}`).join(' / ')}`);
      if (e.mode !== 'suggest') {
        since.ask = e;
        if (!turnRunning) debounceDecide('ask outside a turn');
      }
      return;
    case 'approval':
      noteVisible('approval', e.title, t);
      turn?.cards.push({ t, type: 'approval', title: e.title, detail: e.detail });
      log(`[approval] ${e.title} - ${e.detail} -> allow`);
      run.decisions.push({ t, action: 'approve', id: e.id, title: e.title });
      fetch(`${BASE}/api/sessions/${sid}/approvals/${e.id}`, { method: 'POST', body: JSON.stringify({ ok: true }) })
        .catch((err) => run.errors.push({ t: rel(), where: 'approve', error: String(err.message ?? err) }));
      return;
    case 'plan': {
      const shots = e.shots ?? [];
      const ids = shots.map((s) => s.id).join(',');
      const ready = shots.filter((s) => s.status === 'ready').map((s) => s.id);
      const newReady = ready.filter((x) => !readyShots.has(x));
      for (const s of shots.filter((x) => x.status === 'failed')) {
        const k = `${s.id}:${s.error ?? ''}`;
        if (!failedShots.has(k)) {
          failedShots.set(k, { t, shot: s.id, kind: s.kind, error: s.error ?? '' });
          run.errors.push({ t, where: 'shot', shot: s.id, kind: s.kind, error: s.error ?? 'failed' });
          log(`[shot failed] ${s.id} (${s.kind}) ${s.error ?? ''}`);
        }
      }
      if (!planSeen || ids !== planIds) {
        noteVisible('plan', `${shots.length} shots ${e.seconds}s`, t);
        log(`[plan] ${e.title} · ${e.aspect} · ${e.seconds}s · ${shots.map((s) => `${s.id}:${s.kind}${s.role && s.role !== 'main' ? '/' + s.role : ''}`).join(' ')}`);
      } else if (newReady.length) {
        noteVisible('shot_ready', newReady.join(','), t);
      }
      planSeen = true;
      planIds = ids;
      readyShots = new Set(ready);
      firstOutput('plan', t);
      return;
    }
    case 'video':
      video = { version: e.version, url: e.url, seconds: e.seconds, t, aspect: e.aspect, title: e.title };
      if (e.version >= stage().videoMin) {
        stage().video = video;
        videoTurnEnded = false;
      }
      noteVisible('video', `v${e.version} ${e.seconds}s`, t);
      log(`[video] v${e.version} ${e.seconds}s ${e.url}`);
      if (!turnRunning) debounceDecide('video outside a turn', 1000);
      return;
    case 'images':
      noteVisible('images', `${(e.files ?? []).length} images`, t);
      log(`[images] ${(e.files ?? []).length}`);
      return;
    case 'stage': case 'activity': case 'note': case 'research': case 'shot_status': case 'skill_ref':
      progress.push({ t, type: e.type, text: e.text ?? e.query ?? e.status ?? e.skill ?? '' });
      if (e.type === 'research') log(`[research] ${e.query} (${(e.sources ?? []).length} sources)`);
      else if (e.type === 'stage') log(`[stage] ${e.stage} · ${e.text}`);
      return;
    case 'system':
      log(`[system] ${e.text}`);
      run.errors.push({ t, where: 'system', error: e.text });
      return;
    case 'toast':
      log(`[toast] ${e.level ?? ''} ${e.text}`);
      if (e.level && e.level !== 'info') run.errors.push({ t, where: 'toast', error: e.text });
      return;
    case 'turn_end':
      turnRunning = false;
      lastTurnEnd = { t, ok: e.ok, costUsd: e.costUsd, asked: e.asked, stopped: e.stopped, errors: e.errors };
      if (typeof e.costUsd === 'number') lastCost = e.costUsd;
      if (turn && !turn.end) turn.end = { ms: t - turn.sentAt, ok: e.ok, costUsd: e.costUsd, ...(e.asked ? { asked: true } : {}), ...(e.errors ? { errors: e.errors } : {}) };
      if (!e.ok) run.errors.push({ t, where: 'turn_end', error: JSON.stringify(e.errors ?? 'not ok') });
      if (stage().video) videoTurnEnded = true;
      log(`[turn_end] ok=${e.ok} claude so far $${Number(e.costUsd ?? 0).toFixed(3)}${e.asked ? ' (opener asked)' : ''}`);
      checkpoint();
      debounceDecide('turn_end', 1500);
      return;
    default:
      return;
  }
}

/* ------------------------------ decisions ------------------------------ */
let decideTimer = null;
function debounceDecide(why, ms = 3000) {
  clearTimeout(decideTimer);
  decideTimer = setTimeout(() => void decide(why), ms);
}

const isQuestion = (s) => /[？?]/.test(s) || /(吗|呢|么)\s*[。！!~～]?\s*$/.test(s.trim());

async function decide(why) {
  if (finished || sending || turnRunning) return;
  const sv = stage().video;
  if (sv && (videoTurnEnded || why === 'video grace')) return completeStage();
  if (sv) return; // a video arrived outside a turn: wait for its wrap-up turn or the grace period
  if (rel() - stage().startT > MAX_MS) return finish('timeout');
  const turns = stageTurns();
  let reply = null;
  if (since.ask) {
    const a = since.ask;
    const idx = Number.isInteger(a.recommended) && a.recommended >= 0 && a.recommended < (a.options ?? []).length ? a.recommended : 0;
    reply = { text: a.options[idx], answer: { id: a.id, index: idx }, reason: `ask card: ${Number.isInteger(a.recommended) ? 'recommended' : 'no recommendation, first'} option` };
  } else if (since.script) {
    reply = { text: REPLY_SCRIPT, reason: 'script card without a question card' };
  } else if (lastTurnEnd && lastTurnEnd.ok === false && !lastTurnEnd.stopped) {
    reply = { text: REPLY_RETRY, reason: 'turn ended in an error' };
  } else if (since.lastBubble && isQuestion(since.lastBubble) && since.lastVisibleType === 'bubble') {
    reply = { text: REPLY_PLAIN, reason: 'bot asked in plain text' };
  } else if (why === 'idle nudge') {
    reply = { text: REPLY_PLAIN, reason: `nothing happened for ${IDLE_NUDGE_MS / 1000}s and the session is idle` };
  }
  if (!reply) {
    run.decisions.push({ t: rel(), action: 'wait', why });
    return;
  }
  if (turns >= MAX_TURNS) return finish('max_turns');
  await send(reply.text, reply.reason, reply.answer);
}

async function send(text, reason, answer, media) {
  sending = true;
  const t = rel();
  run.turns.push({ n: run.turns.length + 1, stage: stage().name, text, reason, ...(answer ? { answer } : {}), ...(media?.length ? { media } : {}), sentAt: t, firstVisible: null, end: null, botTexts: [], cards: [] });
  run.decisions.push({ t, action: 'send', text, reason, ...(answer ? { answer } : {}) });
  anchors.push({ t });
  since = { ask: null, script: false, lastBubble: null, lastVisibleType: null };
  log(`>>> User (${reason}): ${text}`);
  try {
    const res = await fetch(`${BASE}/api/sessions/${sid}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(answer ? { answer } : {}), ...(media?.length ? { media } : {}) }),
    });
    if (!res.ok) run.errors.push({ t: rel(), where: 'send', error: `${res.status} ${await res.text()}` });
  } catch (e) {
    run.errors.push({ t: rel(), where: 'send', error: String(e.message ?? e) });
  } finally {
    sending = false;
  }
}

/* ------------------------------ uploads ------------------------------ */
function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), `${prefix}${d.name}/`) : d.isFile() ? [{ path: join(dir, d.name), name: `${prefix}${d.name}` }] : []));
}

async function uploadOne(f, batch) {
  const size = statSync(f.path).size;
  const t = rel();
  const begin = await fetch(`${BASE}/api/sessions/${sid}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, size, batch }) });
  const b = await begin.json().catch(() => ({}));
  if (!begin.ok) throw new Error(b.error ?? `begin ${begin.status}`);
  const fd = openSync(f.path, 'r');
  try {
    for (let off = 0; off < size;) {
      const buf = Buffer.alloc(Math.min(b.chunkBytes, size - off));
      readSync(fd, buf, 0, buf.length, off);
      const r = await fetch(`${BASE}/api/sessions/${sid}/uploads/${b.id}?offset=${off}`, { method: 'PUT', body: buf });
      if (!r.ok) {
        await fetch(`${BASE}/api/sessions/${sid}/uploads/${b.id}`, { method: 'DELETE' }).catch(() => {});
        throw new Error(`chunk at ${off}: ${r.status} ${await r.text()}`);
      }
      off += buf.length;
    }
  } finally {
    closeSync(fd);
  }
  const done = await fetch(`${BASE}/api/sessions/${sid}/uploads/${b.id}/complete`, { method: 'POST' });
  const d = await done.json().catch(() => ({}));
  return { name: f.name, size, status: d.status ?? `http ${done.status}`, kind: d.kind, mediaId: d.mediaId, error: d.error, ms: rel() - t };
}

/** Uploads the task's asset folder and returns the media ids of the files that were accepted. */
async function uploadAssets(dir) {
  const files = walk(dir);
  const batch = `h${Date.now().toString(36)}`;
  const t = rel();
  const out = [];
  const queue = [...files];
  await Promise.all([0, 1].map(async () => {
    for (let f; (f = queue.shift());) out.push(await uploadOne(f, batch).catch((e) => ({ name: f.name, status: 'error', error: String(e.message ?? e) })));
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  run.uploads = { dir, files: out, seconds: secs(rel() - t), bytes: out.reduce((a, x) => a + (x.size ?? 0), 0) };
  const bad = out.filter((x) => x.status !== 'complete');
  log(`uploaded ${out.length - bad.length}/${out.length} files (${Math.round(run.uploads.bytes / 1048576)} MB) in ${run.uploads.seconds}s${bad.length ? ` · not accepted: ${bad.map((x) => `${x.name} (${x.error ?? x.status})`).join(', ')}` : ''}`);
  checkpoint();
  return out.filter((x) => x.mediaId).map((x) => x.mediaId);
}

/* ------------------------------ SSE ------------------------------ */
async function stream() {
  while (!finished) {
    try {
      const res = await fetch(`${BASE}/api/sessions/${sid}/events`);
      if (!res.ok) throw new Error(`events ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              onEvent(JSON.parse(line.slice(6)));
            } catch (err) {
              run.errors.push({ t: rel(), where: 'event', error: String(err.message ?? err) });
            }
          }
        }
      }
      reader.cancel().catch(() => {});
    } catch (e) {
      if (finished) return;
      run.errors.push({ t: rel(), where: 'sse', error: String(e.message ?? e) });
    }
    if (!finished) {
      log('[sse] reconnecting');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function sessionBusy() {
  try {
    const r = await fetch(`${BASE}/api/sessions/${sid}`);
    return Boolean((await r.json()).busy);
  } catch {
    return null;
  }
}

/* ------------------------------ summary ------------------------------ */
function maxGap(points, until) {
  const pts = points.filter((p) => p.t <= until).sort((a, b) => a.t - b.t);
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].t - pts[i - 1].t;
    if (!best || g > best.ms) best = { ms: g, seconds: secs(g), from: { t: secs(pts[i - 1].t), type: pts[i - 1].type, label: pts[i - 1].label }, to: { t: secs(pts[i].t), type: pts[i].type, label: pts[i].label } };
  }
  return best;
}

function trajectoryStats(dir) {
  const file = join(dir, 'trajectory.jsonl');
  const out = { toolCalls: {}, toolErrors: [], denied: [], openers: [], narrationHeld: 0 };
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const tool = String(j.data?.tool ?? '').replace(/^mcp__[^_]+__/, '');
    if (j.kind === 'tool_call') out.toolCalls[tool] = (out.toolCalls[tool] ?? 0) + 1;
    else if (j.kind === 'tool_result' && j.data?.error) out.toolErrors.push({ at: j.ts, tool, output: String(typeof j.data.output === 'string' ? j.data.output : JSON.stringify(j.data.output)).slice(0, 300) });
    else if (j.kind === 'tool_denied') out.denied.push({ at: j.ts, tool, reason: String(j.data?.reason ?? '').slice(0, 200) });
    else if (j.kind === 'opener') out.openers.push({ at: j.ts, kind: j.data?.kind, used: j.data?.used, asks: j.data?.asks, ms: j.data?.ms, say: j.data?.say });
    else if (j.kind === 'opener_error') out.openers.push({ at: j.ts, error: String(j.data ?? '').slice(0, 200) });
    else if (j.kind === 'narration') out.narrationHeld++;
  }
  return out;
}

function shotSummary(project) {
  const shots = project?.shots ?? [];
  const main = shots.filter((s) => !s.role || s.role === 'main');
  const count = (xs) => xs.reduce((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {});
  const seconds = (xs) => xs.reduce((m, s) => ((m[s.kind] = Math.round(((m[s.kind] ?? 0) + Number(s.seconds || 0)) * 10) / 10), m), {});
  return {
    total: shots.length, main: main.length, overlays: shots.length - main.length,
    byKind: count(shots), mainByKind: count(main), mainSecondsByKind: seconds(main),
    roles: shots.reduce((m, s) => ((m[s.role ?? 'main'] = (m[s.role ?? 'main'] ?? 0) + 1), m), {}),
    transitions: main.filter((s) => s.transition).length,
    withVo: main.filter((s) => s.vo).length, withAudio: shots.filter((s) => s.audio).length,
    mainSeconds: Math.round(main.reduce((a, s) => a + Number(s.seconds || 0), 0) * 10) / 10,
  };
}

async function videoInfoOf(v) {
  const dir = sessionDir(sid);
  const relPath = decodeURIComponent(v.url.replace(`/files/${sid}/`, ''));
  const path = join(dir, relPath);
  const snap = join(dir, `versions/v${v.version}.project.json`);
  const project = readJson(existsSync(snap) ? snap : join(dir, 'project.json'), null);
  const info = { version: v.version, path, url: `${BASE}${v.url}`, seconds: v.seconds, probedSeconds: existsSync(path) ? Math.round((await probeDuration(path)) * 100) / 100 : null, aspect: v.aspect, title: v.title, projectSnapshot: existsSync(snap) ? snap : join(dir, 'project.json'), atSeconds: secs(v.t) };
  return { info, project };
}

/** Timing, cost and output figures for the part of the run between fromT and toT (ms since start). */
async function windowSummary(fromT, toT, v, turns) {
  const latencies = turns.map((t) => t.firstVisible?.ms).filter((x) => typeof x === 'number');
  const endT = v?.t ?? toT;
  const inWin = (x) => x.t >= fromT && x.t <= endT;
  const anchorPts = anchors.filter(inWin).map((a) => ({ ...a, type: 'user', label: 'user message' }));
  let videoInfo = null;
  let project = null;
  if (v && sid) ({ info: videoInfo, project } = await videoInfoOf(v));
  else if (sid) project = readJson(join(sessionDir(sid), 'project.json'), null);
  const keep = (e) => { const t = Date.parse(e.ts) - T0; return t >= fromT - 1000 && t <= toT + 5000; };
  const ledger = sid ? ledgerFor(sid, keep) : null;
  const claudeEnd = turns.map((t) => t.end?.costUsd).filter((x) => typeof x === 'number').at(-1) ?? 0;
  const claudeStart = run.turns.filter((t) => t.sentAt < fromT).map((t) => t.end?.costUsd).filter((x) => typeof x === 'number').at(-1) ?? 0;
  const claudeTurnEnd = Math.max(0, claudeEnd - claudeStart);
  const claudeUsd = ledger && ledger.claudeUsd > 0 ? ledger.claudeUsd : claudeTurnEnd;
  return {
    wallSeconds: secs(toT - fromT),
    secondsToVideo: v ? secs(v.t - fromT) : null,
    userTurns: turns.length,
    replies: turns.map((t) => ({ n: t.n, text: t.text, reason: t.reason })),
    firstOutputMs: { turn1: turns[0]?.firstVisible?.ms ?? null, max: latencies.length ? Math.max(...latencies) : null, perTurn: turns.map((t) => t.firstVisible) },
    maxSilentGap: maxGap([...visible.filter(inWin), ...anchorPts], endT),
    maxSilentGapInclProgress: maxGap([...visible.filter(inWin), ...progress.filter(inWin), ...anchorPts], endT),
    visibleOutputs: visible.filter(inWin).length,
    video: videoInfo,
    shots: project ? shotSummary(project) : null,
    script: project?.script ? { version: project.script.version, segments: project.script.segments?.length, total_seconds: project.script.total_seconds, aspect: project.script.aspect, sources: project.script.sources?.length ?? 0 } : null,
    cost: ledger ? {
      totalUsd: Math.round((ledger.nonClaudeUsd + claudeUsd) * 10000) / 10000,
      nonClaudeUsd: ledger.nonClaudeUsd, claudeUsd,
      claudeFromTurnEnds: Math.round(claudeTurnEnd * 10000) / 10000, claudeLedger: ledger.claudeUsd, claudeLedgerAgent: ledger.claudeAgentUsd, claudeLedgerOpener: ledger.claudeOpenerUsd,
      byKind: ledger.byKind, entries: ledger.entries.length, estimatedEntries: ledger.estimatedEntries,
      note: 'totalUsd = non-Claude ledger entries + Claude (ledger Claude entries when the app books them, which already include the agent turns and opener calls; else the growth of turn_end costUsd); entries booked in this window',
    } : null,
  };
}

async function summarize() {
  const dir = sid ? sessionDir(sid) : null;
  // The whole run (for single-stage topics this is the only summary), with the last video delivered.
  const whole = await windowSummary(0, rel(), stageState.at(-1).video ?? video, run.turns);
  run.summary = { ...whole, wallSeconds: secs(rel()), trajectory: dir ? trajectoryStats(dir) : null, errorCount: run.errors.length };
  if (STAGES.length > 1) {
    run.stages = [];
    for (const [i, st] of stageState.entries()) {
      if (st.startT === null) { run.stages.push({ name: st.name, prompt: st.prompt, reached: false }); continue; }
      const toT = st.endT ?? rel();
      run.stages.push({ name: st.name, prompt: st.prompt, reached: true, delivered: Boolean(st.video), startT: secs(st.startT), endT: secs(toT), ...(await windowSummary(st.startT, toT, st.video, run.turns.filter((t) => t.stage === st.name))) });
    }
  }
}

function checkpoint() {
  run.endedAt = new Date().toISOString();
  try { writeJson(OUT, run); } catch (e) { console.error('checkpoint failed', e.message); }
}

/** The current stage delivered its video: start the next stage with its prompt, or finish. */
async function completeStage() {
  const st = stage();
  st.endT = rel();
  log(`[stage ${st.name} done] v${st.video.version} ${st.video.seconds}s`);
  if (stageIdx + 1 >= STAGES.length) return finish('video');
  stageIdx++;
  const next = stage();
  next.startT = rel();
  next.videoMin = (video?.version ?? 0) + 1;
  lastTurnEnd = null;
  checkpoint();
  await send(next.prompt, `stage ${next.name} prompt`);
}

async function finish(reason) {
  if (finished) return;
  finished = true;
  run.stopReason = reason;
  log(`[stop] ${reason}`);
  if (reason === 'timeout' && sid && (turnRunning || (await sessionBusy()))) {
    // A user who gives up presses stop, so the run does not keep spending after the harness leaves.
    try { await fetch(`${BASE}/api/sessions/${sid}/interrupt`, { method: 'POST' }); run.decisions.push({ t: rel(), action: 'interrupt' }); } catch {}
  }
  await new Promise((r) => setTimeout(r, 3000)); // trailing events (late ledger entries, wrap-up)
  await summarize().catch((e) => run.errors.push({ t: rel(), where: 'summary', error: String(e.stack ?? e) }));
  run.inProgress = false;
  checkpoint();
  const s = run.summary ?? {};
  log(`[done] ${topicId} session ${sid} · ${s.userTurns} turns · ${s.wallSeconds}s · video ${s.video ? s.video.path + ' ' + s.video.seconds + 's' : 'none'} · $${s.cost?.totalUsd}`);
  process.exit(0);
}

/* ------------------------------ main ------------------------------ */
const created = await fetch(`${BASE}/api/sessions`, { method: 'POST', body: '{"botId":"video"}' }).then((r) => r.json());
sid = created.id;
run.sessionId = sid;
log(`topic ${topicId} ${topic.title} · session ${sid}`);
void stream();
await new Promise((r) => setTimeout(r, 1500)); // let the event stream attach first
const media = topic.assets ? await uploadAssets(topic.assets) : [];
stage().startT = rel();
await send(STAGES[0].prompt, STAGES.length > 1 ? 'stage A prompt' : 'topic prompt', undefined, media);
checkpoint();

setInterval(async () => {
  if (finished) return;
  if (rel() - stage().startT > MAX_MS) return finish('timeout');
  if (sending || turnRunning) return;
  const sv = stage().video;
  if (sv && !videoTurnEnded && rel() - sv.t > VIDEO_GRACE_MS) return decide('video grace');
  if (sv) return;
  if (Date.now() - lastEventAt < IDLE_NUDGE_MS) return;
  const busy = await sessionBusy();
  if (busy) return; // background jobs still running
  lastEventAt = Date.now();
  if (stageTurns() >= MAX_TURNS) return finish('max_turns');
  void decide('idle nudge');
}, 10_000).unref?.();
setInterval(checkpoint, 60_000).unref?.();
// Keep the process alive while the stream is open.
setInterval(() => {}, 1 << 30);
