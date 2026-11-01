import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CHAT_MODELS, config, relayReady, RESOLUTION, SEEDANCE_MODELS, seedanceMocked, VOICES, type Aspect } from './core/config.ts';
import { AgentSession, type Upload } from './agent/agent.ts';
import { closeBrowser } from './render/renderer.ts';
import { pruneModelCache } from './render/models.ts';
import { isClaudeModel, ledger, pricing } from './core/ledger.ts';
import { BOTS, botById } from './core/bots.ts';
import { readdir, statfs } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { warmUp } from './providers/llm.ts';
import { buildTurns, readLines } from './agent/trajectory.ts';
import { REVIEWS_FILE, reviewPending, reviewQueue } from './agent/review.ts';
import { CATEGORIES, memory, PROMPT_LIMIT } from './agent/memory.ts';
import { seedanceModel, settings } from './core/settings.ts';
import { readEntries } from './core/ledger.ts';
import { listSkills, skillReadme, writeSkillMeta } from './core/skills.ts';
import { renderLoad } from './render/renderer.ts';
import { serviceHealth } from './agent/agent.ts';
import { pendingSeedanceCount } from './tools/index.ts';
import { jobStore } from './core/jobs.ts';
import { abortUpload, beginUpload, completeUpload, setGlobalUploadRoot, UPLOAD_LIMITS, writeChunk } from './media/uploads.ts';
import { readIndex } from './media/ingest.ts';
import { estimateClipUsd } from './providers/seedance.ts';

/** The image type from a file's first bytes (PNG, JPEG, WebP, GIF), or null. */
function imageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

const STARTED_AT = new Date().toISOString();
const BUILD = (() => {
  try {
    return JSON.parse(readFileSync(resolve('BUILD.json'), 'utf8')) as { commit?: string; deployedAt?: string };
  } catch {
    try {
      return { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() };
    } catch {
      return {};
    }
  }
})();

async function allSessions() {
  const ids = (await readdir(SESSIONS, { withFileTypes: true })).filter((d) => d.isDirectory() && ID.test(d.name) && !deleting(d.name)).map((d) => d.name);
  const out: AgentSession[] = [];
  for (const id of ids) {
    const s = await getSession(id);
    if (s && s.history.length) out.push(s);
  }
  return out;
}

function budgetState() {
  const spent = ledger.spent();
  const limit = ledger.limit();
  const level = spent >= limit ? 'red' : spent >= limit * pricing.warnRatio || seedanceMocked() ? 'yellow' : 'green';
  return { spent, limit, ratio: spent / limit, level };
}

const PUBLIC = resolve('public');
const SESSIONS = join(config.dataDir, 'sessions');
const sessions = new Map<string, AgentSession>();
const ID = /^[a-f0-9-]{36}$/;

/**
 * The page version: the build plus the front-end files as served, so it changes whenever the page would. index.html
 * links app.js and app.css with ?v= of it, and the event stream opens with it, so a tab left open across a deploy
 * notices and reloads.
 */
const PAGE_FILES = ['index.html', 'app.js', 'app.css'];
const PAGE_VERSION = createHash('sha1').update(String(BUILD.commit ?? '')).update(PAGE_FILES.map((f) => { try { return readFileSync(join(PUBLIC, f)); } catch { return ''; } }).join('\0')).digest('hex').slice(0, 10);
const INDEX_HTML = (() => { try { return readFileSync(join(PUBLIC, 'index.html'), 'utf8').replace(/(\/static\/app\.(?:js|css))"/g, `$1?v=${PAGE_VERSION}"`).replace('<head>', `<head>\n<meta name="page-version" content="${PAGE_VERSION}">`); } catch { return ''; } })();

const MEDIA = new Set(['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

const loading = new Map<string, Promise<AgentSession>>();
let exporting = false;

/* ---------- trash ----------
   Deleting is soft: the session folder gets a .deleting marker (hidden from everything at once), and moves to
   data/trash/ when its turn and any background Seedance jobs have finished. Trash is purged after TRASH_DAYS. */
const TRASH = join(config.dataDir, 'trash');
const TRASH_DAYS = config.trashDays;
const MARKER = '.deleting';
const TRASH_META = '.trash.json';
const deleting = (id: string) => existsSync(join(SESSIONS, id, MARKER));

async function moveToTrash(id: string) {
  sessions.get(id)?.close();
  sessions.delete(id);
  await mkdir(TRASH, { recursive: true });
  const dest = join(TRASH, id);
  await rm(dest, { recursive: true, force: true });
  await rename(join(SESSIONS, id), dest);
  await rename(join(dest, MARKER), join(dest, TRASH_META));
}

async function trashSession(s: AgentSession) {
  const title = s.summary().title;
  await writeFile(join(SESSIONS, s.id, MARKER), JSON.stringify({ deletedAt: Date.now(), title }));
  s.shutdown();
  void (async () => {
    const until = Date.now() + 30 * 60_000;
    while ((s.busy || s.hasBackgroundJobs()) && Date.now() < until) await new Promise((r) => setTimeout(r, 1000));
    if (deleting(s.id)) await moveToTrash(s.id);
  })().catch((e) => console.error('trash', s.id, e));
}

async function listTrash() {
  const out: Array<{ id: string; title: string; deletedAt: number; pending: boolean }> = [];
  for (const [root, file, pending] of [[TRASH, TRASH_META, false], [SESSIONS, MARKER, true]] as const) {
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (!d.isDirectory() || !ID.test(d.name)) continue;
      try {
        const m = JSON.parse(await readFile(join(root, d.name, file), 'utf8')) as { title?: string; deletedAt?: number };
        out.push({ id: d.name, title: m.title || '新对话', deletedAt: m.deletedAt ?? 0, pending });
      } catch {}
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

async function restoreSession(id: string) {
  if (deleting(id)) {
    await unlink(join(SESSIONS, id, MARKER));
    return true;
  }
  const src = join(TRASH, id);
  if (!existsSync(src) || existsSync(join(SESSIONS, id))) return false;
  await rename(src, join(SESSIONS, id));
  await rm(join(SESSIONS, id, TRASH_META), { force: true });
  return true;
}

async function sweepTrash() {
  for (const t of await listTrash()) {
    if (t.pending) {
      // Left over from a restart mid-delete: nothing is running for it any more.
      if (!sessions.has(t.id)) await moveToTrash(t.id).catch((e) => console.error('trash', t.id, e));
    } else if (Date.now() - t.deletedAt > TRASH_DAYS * 86_400_000) {
      await rm(join(TRASH, t.id), { recursive: true, force: true });
    }
  }
}

async function getSession(id: string, create = false): Promise<AgentSession | null> {
  if (!ID.test(id) || deleting(id)) return null;
  const s = sessions.get(id);
  if (s) return s;
  const dir = join(SESSIONS, id);
  if (!create && !existsSync(dir)) return null;
  let p = loading.get(id);
  if (!p) {
    p = (async () => {
      await mkdir(dir, { recursive: true });
      const created = new AgentSession(id, dir);
      await created.init();
      sessions.set(id, created);
      return created;
    })().finally(() => loading.delete(id));
    loading.set(id, p);
  }
  return p;
}

/**
 * The caller's address; a forwarded one is believed only from a proxy on this machine (nginx in front), and
 * only its last hop: that is the one nginx added, anything before it came from the caller.
 */
function clientIp(req: http.IncomingMessage) {
  const peer = req.socket.remoteAddress ?? '';
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
  return /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(peer) && fwd ? fwd : peer;
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 30 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  if (!existsSync(file) || !statSync(file).isFile()) return json(res, 404, { error: 'not found' });
  const { size, mtime } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const etag = `W/"${size.toString(16)}-${Math.floor(mtime.getTime() / 1000).toString(16)}"`;
  const lastModified = mtime.toUTCString();
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', lastModified);
  if (req.headers['if-none-match'] === etag || (!req.headers['if-none-match'] && req.headers['if-modified-since'] === lastModified)) { res.writeHead(304); return void res.end(); }
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'X-Content-Type-Options': 'nosniff', 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // HEAD answers like GET without the body (health checks and caches use it).
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (read && (url.pathname === '/' || parts[0] === 'static')) {
      // Always revalidated; the ETag keeps that to a 304 when nothing changed.
      res.setHeader('Cache-Control', 'no-cache');
      if (url.pathname === '/' && INDEX_HTML) {
        const etag = `"${PAGE_VERSION}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return void res.end(); }
        res.writeHead(200, { 'X-Content-Type-Options': 'nosniff', 'Content-Type': MIME['.html'], ETag: etag });
        return void res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
      }
      const rel = url.pathname === '/' ? 'index.html' : parts.slice(1).join('/');
      const file = normalize(join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
      return sendFile(req, res, file);
    }

    if (read && parts[0] === 'files' && parts[1]) {
      const base = resolve(SESSIONS, parts[1]);
      const file = normalize(join(base, ...parts.slice(2).map(decodeURIComponent)));
      // Session folders also hold model-written HTML; only media is ever served from them.
      if (!ID.test(parts[1]) || !file.startsWith(base + '/') || !MEDIA.has(extname(file).toLowerCase())) return json(res, 403, { error: 'forbidden' });
      return sendFile(req, res, file);
    }

    if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });

    if (req.method === 'GET' && parts[1] === 'config') {
      const b = budgetState();
      return json(res, 200, { level: b.level, skills: listSkills().filter((x) => x.enabled).map((x) => ({ name: x.name, description: x.description })) });
    }

    if (req.method === 'GET' && parts[1] === 'bots') {
      return json(res, 200, { bots: BOTS });
    }

    if (req.method === 'GET' && parts[1] === 'sessions' && parts.length === 2) {
      const q = (url.searchParams.get('q') ?? '').trim();
      const list = (await allSessions()).filter((s) => !q || s.matches(q)).map((s) => s.summary());
      list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
      return json(res, 200, { sessions: list });
    }

    if (req.method === 'GET' && parts[1] === 'system') {
      const sessionsById = new Map((await allSessions()).map((s) => [s.id, s.summary()]));
      const entries = readEntries();
      const isClaude = isClaudeModel;
      const byConv = new Map<string, { id: string; title: string; thumb: string | null; shots: number; usd: number }>();
      for (const e of entries) {
        const info = sessionsById.get(e.session);
        const row = byConv.get(e.session) ?? { id: e.session, title: info?.title ?? (e.session === 'system' ? '系统' : '已删除的对话'), thumb: info?.thumb ?? null, shots: 0, usd: 0 };
        row.usd += e.usd;
        if (!isClaude(e.model)) row.shots++;
        byConv.set(e.session, row);
      }
      let disk = null;
      try {
        const st = await statfs(config.dataDir);
        disk = { usedGb: ((st.blocks - st.bfree) * st.bsize) / 1e9, totalGb: (st.blocks * st.bsize) / 1e9 };
      } catch {}
      return json(res, 200, {
        budget: budgetState(),
        usage: {
          claudeUsd: entries.filter((e) => isClaude(e.model)).reduce((a, e) => a + e.usd, 0),
          seedanceUsd: entries.filter((e) => !isClaude(e.model)).reduce((a, e) => a + e.usd, 0),
          seedanceEstimated: entries.filter((e) => !isClaude(e.model) && e.basis === 'estimate').length,
          claudeCounted: pricing.claudeBilled,
          conversations: [...byConv.values()].sort((a, b) => b.usd - a.usd),
          entries: entries.slice(-300).reverse().map((e) => ({ ...e, title: sessionsById.get(e.session)?.title ?? (e.session === 'system' ? '系统' : '') })),
          rate: pricing.usdCnyRate,
        },
        skills: listSkills().map(({ dir: _dir, ...s }) => s),
        settings: settings.get(),
        status: {
          claude: {
            model: config.model,
            endpoint: process.env.ANTHROPIC_BASE_URL ? 'configured' : process.env.ANTHROPIC_API_KEY ? 'api-key' : 'local-login',
            okAt: serviceHealth.claudeOkAt ?? null,
            errorAt: serviceHealth.claudeErrorAt ?? null,
            error: serviceHealth.claudeError ?? null,
          },
          seedance: { mock: seedanceMocked(), model: seedanceModel().label, resolution: RESOLUTION, pending: pendingSeedanceCount() },
          render: renderLoad(),
          disk,
        },
        about: { commit: BUILD.commit ?? null, deployedAt: BUILD.deployedAt ?? null, startedAt: STARTED_AT, pageVersion: PAGE_VERSION },
      });
    }

    if (req.method === 'GET' && parts[1] === 'models') {
      const voices = Object.fromEntries(Object.entries(VOICES).map(([k, v]) => [k, v.label]));
      return json(res, 200, { chat: CHAT_MODELS, seedance: SEEDANCE_MODELS, voices, settings: settings.get(), relay: relayReady() });
    }

    if (parts[1] === 'settings') {
      if (req.method === 'POST') return json(res, 200, settings.set(JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')));
      return json(res, 200, settings.get());
    }

    if (parts[1] === 'memory') {
      const id = parts[2];
      if (req.method === 'GET' && !id) {
        const titles = new Map((await allSessions()).map((x) => [x.id, x.summary().title]));
        const items = memory.list().map((m) => ({ ...m, evidence: m.evidence.map((ev) => ({ ...ev, title: titles.get(ev.session) ?? null })) }));
        return json(res, 200, { items, categories: CATEGORIES, promptLimit: PROMPT_LIMIT, autoUpdate: settings.get().memoryAutoUpdate });
      }
      const body = req.method === 'POST' ? JSON.parse((await readBody(req, 16_384)).toString('utf8') || '{}') as { category?: string; content?: string } : {};
      if (req.method === 'POST' && !id) {
        const item = memory.add(String(body.category ?? ''), String(body.content ?? ''));
        return json(res, item ? 200 : 400, item ?? { error: 'need a category and some text' });
      }
      if (req.method === 'POST' && id) {
        const item = memory.edit(id, body);
        return json(res, item ? 200 : 404, item ?? { error: 'not found' });
      }
      if (req.method === 'DELETE' && id) return json(res, memory.remove(id) ? 200 : 404, { ok: true });
    }

    if (req.method === 'GET' && parts[1] === 'reviews') {
      const titles = new Map((await allSessions()).map((x) => [x.id, x.summary().title]));
      const rows = readLines(REVIEWS_FILE).map((l) => {
        const r = l as unknown as Record<string, unknown>;
        return { ...r, title: titles.get(String(r.session)) ?? `${r.title}（已删除）`, deleted: !titles.has(String(r.session)) };
      });
      return json(res, 200, { rows: rows.reverse(), enabled: settings.get().reviewEnabled, pending: reviewQueue() });
    }

    if (req.method === 'GET' && parts[1] === 'export') {
      // Everything needed to compare harnesses offline: every turn's trajectory, the reviews, memory and spend.
      const ids = (await allSessions()).map((x) => x.id);
      const files = ['reviews.jsonl', 'memory.json', 'settings.json', 'ledger.jsonl', ...ids.flatMap((id) => [`sessions/${id}/trajectory.jsonl`, `sessions/${id}/meta.json`, `sessions/${id}/project.json`])]
        .filter((f) => existsSync(join(config.dataDir, f)));
      if (!files.length) return json(res, 404, { error: 'nothing to export yet' });
      if (exporting) return json(res, 429, { error: 'another export is running' });
      exporting = true;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="video-agent-trajectories-${stamp}.tar.gz"` });
      const tar = spawn('tar', ['-czf', '-', '--ignore-failed-read', '-C', config.dataDir, ...files], { stdio: ['ignore', 'pipe', 'ignore'] });
      tar.on('error', () => res.destroy());
      tar.on('close', (code) => { exporting = false; if (code) res.destroy(); });
      tar.stdout.pipe(res);
      req.on('close', () => tar.kill());
      return;
    }

    if (parts[1] === 'trash') {
      if (req.method === 'GET' && parts.length === 2) return json(res, 200, { days: TRASH_DAYS, items: await listTrash() });
      const id = parts[2] ?? '';
      if (!ID.test(id)) return json(res, 404, { error: 'not found' });
      if (req.method === 'POST' && parts[3] === 'restore') return json(res, (await restoreSession(id)) ? 200 : 409, { ok: true });
      if (req.method === 'DELETE' && parts.length === 3) {
        if (!existsSync(join(TRASH, id))) return json(res, 409, { error: 'not in trash yet' });
        await rm(join(TRASH, id), { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'skills' && parts[2]) {
      const skill = listSkills().find((x) => x.name === parts[2]);
      if (!skill) return json(res, 404, { error: 'no such skill' });
      if (req.method === 'GET' && parts[3] === 'readme') return json(res, 200, { name: skill.name, text: skillReadme(skill.name) });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { enabled?: boolean };
        writeSkillMeta(skill.name, { enabled: Boolean(body.enabled) });
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'POST' && parts[1] === 'sessions' && parts.length === 2) {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { botId?: string };
      const s = await getSession(randomUUID(), true);
      s!.botId = botById(body.botId).id;
      return json(res, 200, { id: s!.id });
    }

    const s = parts[1] === 'sessions' && parts[2] ? await getSession(parts[2]) : null;
    if (!s) return json(res, 404, { error: 'no such session' });

    if (req.method === 'GET' && parts.length === 3) {
      return json(res, 200, { ...s.summary(), versions: s.store.project.versions.length, model: s.wantModel(), modelOverride: s.modelOverride });
    }

    if (req.method === 'POST' && parts[3] === 'pin') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { pinned?: boolean };
      await s.setPinned(Boolean(body.pinned));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && parts[3] === 'trajectory') {
      return json(res, 200, { turns: buildTurns(s.store.path('trajectory.jsonl'), s.id), reviewEnabled: settings.get().reviewEnabled, pendingIds: reviewPending(), busy: s.busy });
    }

    if (req.method === 'GET' && parts[3] === 'trajectory.jsonl') {
      const file = s.store.path('trajectory.jsonl');
      if (!existsSync(file)) return json(res, 404, { error: 'no trajectory yet' });
      // The file keeps growing while a turn runs; send exactly the bytes counted here.
      const size = statSync(file).size;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': `attachment; filename="trajectory-${s.id.slice(0, 8)}.jsonl"`, 'Content-Length': size });
      if (!size) return void res.end();
      createReadStream(file, { end: size - 1 }).pipe(res);
      return;
    }

    if (req.method === 'POST' && parts[3] === 'feedback') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { version?: number; rating?: string; comment?: string };
      if (body.rating !== 'up' && body.rating !== 'down') return json(res, 400, { error: 'rating must be up or down' });
      return json(res, s.feedback(Number(body.version), body.rating, String(body.comment ?? '')) ? 200 : 404, { ok: true });
    }

    if (req.method === 'POST' && parts[3] === 'model') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { model?: string };
      const model = String(body.model ?? '');
      if (model && !CHAT_MODELS.some((m) => m.id === model)) return json(res, 400, { error: 'unknown model' });
      await s.setModel(model);
      return json(res, 200, { model: s.wantModel(), override: s.modelOverride });
    }

    if (req.method === 'POST' && parts[3] === 'title') {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { title?: string };
      await s.setTitle(String(body.title ?? ''));
      return json(res, 200, { title: s.summary().title });
    }

    if (req.method === 'POST' && parts[3] === 'delete') {
      await trashSession(s);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && parts[3] === 'approvals' && parts[4]) {
      const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { ok?: boolean };
      return json(res, s.decide(parts[4], Boolean(body.ok)) ? 200 : 409, { ok: true });
    }

    if (req.method === 'GET' && parts[3] === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      send({ type: 'replay', events: s.history, busy: s.busy, pendingApprovals: s.pendingApprovalIds(), pageVersion: PAGE_VERSION });
      const off = s.subscribe(send);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      s.lastActive = Date.now();
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }

    // Uploads: begin -> chunks (PUT, contiguous offsets, <= 4 MB each) -> complete (validated, then ingested).
    if (parts[3] === 'uploads') {
      if (req.method === 'POST' && !parts[4]) {
        const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}') as { name?: string; size?: number; batch?: string };
        if (typeof body.name !== 'string' || !Number.isSafeInteger(body.size) || body.size! <= 0) return json(res, 400, { error: '缺少文件名或大小' });
        try {
          const u = beginUpload(s.id, s.store.dir, { name: body.name, size: body.size!, ip: clientIp(req) });
          s.uploadBegan(u, typeof body.batch === 'string' ? body.batch.slice(0, 40) : u.id);
          return json(res, 200, { id: u.id, chunkBytes: UPLOAD_LIMITS.chunkBytes });
        } catch (e) {
          return json(res, 429, { error: (e as Error).message });
        }
      }
      const uid = parts[4] ?? '';
      if (req.method === 'PUT' && uid && !parts[5]) {
        const offset = Number(url.searchParams.get('offset'));
        if (!Number.isSafeInteger(offset) || offset < 0) return json(res, 400, { error: 'offset 不对' });
        try {
          const data = await readBody(req, UPLOAD_LIMITS.chunkBytes);
          const u = await writeChunk(s.id, uid, offset, data);
          return json(res, 200, { received: u.received });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
      }
      if (req.method === 'POST' && uid && parts[5] === 'complete') {
        try {
          const u = await completeUpload(s.id, uid);
          const media = s.uploadCompleted(u);
          return json(res, 200, { status: u.status, kind: u.kind, error: u.error, mediaId: media?.id });
        } catch (e) {
          return json(res, 409, { error: (e as Error).message });
        }
      }
      if (req.method === 'DELETE' && uid) {
        abortUpload(s.id, uid);
        s.uploadAborted(uid);
        return json(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && parts[3] === 'media') {
      return json(res, 200, { items: readIndex(s.store.dir).map(({ text: _t, ...m }) => m) });
    }

    if (req.method === 'POST' && parts[3] === 'messages') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as { text?: string; skill?: string; images?: Array<{ name: string; mime: string; data: string }>; answer?: { id?: string; index?: number; picks?: number[] }; media?: string[] };
      const text = (body.text ?? '').slice(0, 8000);
      // The type comes from the file's own header, not the declared one: anything that is not really a
      // PNG, JPEG, WebP or GIF is dropped before it is saved or handed to ffmpeg.
      const uploads: Upload[] = (body.images ?? []).slice(0, 6)
        .flatMap((i): Upload[] => {
          const data = Buffer.from(String(i.data ?? ''), 'base64');
          const mime = imageType(data);
          return mime ? [{ name: i.name || 'image', mime, data }] : [];
        });
      const media = Array.isArray(body.media) ? body.media.filter((x) => typeof x === 'string' && /^m\d{1,4}$/.test(x)).slice(0, 50) : [];
      if (!text.trim() && !uploads.length && !media.length) return json(res, 400, { error: 'empty message' });
      const picks = Array.isArray(body.answer?.picks) && body.answer.picks.length <= 3 && body.answer.picks.every((x) => Number.isInteger(x) && x >= -1 && x < 4) ? body.answer.picks.map(Number) : undefined;
      const answer = body.answer && typeof body.answer.id === 'string' && (Number.isInteger(body.answer.index) || picks)
        ? { id: body.answer.id.slice(0, 64), index: Number.isInteger(body.answer.index) ? Number(body.answer.index) : -1, ...(picks ? { picks } : {}) }
        : undefined;
      await s.send(text, uploads, typeof body.skill === 'string' ? body.skill : undefined, answer, media);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && parts[3] === 'interrupt') {
      await s.interrupt();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String((e as Error).message) });
  }
});

setInterval(() => {
  for (const [id, s] of sessions) {
    if (!s.busy && !s.hasListeners() && !s.hasBackgroundJobs() && Date.now() - s.lastActive > config.idleSessionMs) {
      s.close();
      sessions.delete(id);
    }
  }
}, 60_000).unref();

// A background promise that fails without a handler is logged instead of taking the whole server down.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
await mkdir(SESSIONS, { recursive: true });
setGlobalUploadRoot(SESSIONS);
// Realistic shots submitted before a restart: their conversations are loaded so the tasks are polled again
// (by task id, never resubmitted) and land in the right place. A conversation that was being deleted has
// its tasks booked at the estimate and closed instead, so nothing paid goes unrecorded. Done before the
// trash sweep, which would otherwise move such a conversation away first.
for (const id of new Set(jobStore.open().map((j) => j.session))) {
  const s = await getSession(id).catch((e) => { console.error('resume jobs', id, e); return null; });
  if (s) continue;
  for (const j of jobStore.open().filter((x) => x.session === id)) {
    if (!j.charged) ledger.record({ session: id, item: `${j.item}（对话已删除）`, model: j.params.model, usage: 'estimate', usd: estimateClipUsd({ seconds: j.params.seconds, aspect: j.params.aspect as Aspect }), basis: 'estimate' });
    jobStore.update(j.taskId, { status: 'discarded', charged: true });
  }
}
await sweepTrash();
await pruneModelCache().catch((e) => console.error('model cache', e));
setInterval(() => { for (const s of sessions.values()) s.heartbeat(); }, 10_000).unref();
// Synchronous work that freezes the server shows up here (child processes then look hung and time out).
let tick = Date.now();
setInterval(() => {
  const lag = Date.now() - tick - 1000;
  if (lag > 1500) console.warn(`event loop stalled ${lag} ms`);
  tick = Date.now();
}, 1000).unref();
setInterval(() => void sweepTrash().catch((e) => console.error('trash sweep', e)), 3600_000).unref();
setInterval(() => void pruneModelCache().catch((e) => console.error('model cache', e)), 3600_000).unref();
await readFile(join(PUBLIC, 'index.html')).catch(() => { throw new Error('public/index.html missing'); });
server.listen(config.port, config.host, () => {
  console.log(`video agent demo on http://${config.host}:${config.port}  model=${config.model} effort=${config.effort} seedance=${seedanceMocked() ? 'mock' : config.seedance.baseUrl}`);
  void warmUp(config.model).then((usd) => {
    if (pricing.claudeBilled && usd > 0) ledger.record({ session: 'system', item: '启动预热', model: config.model, usage: 'warm-up', usd, basis: 'estimate' });
  });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    for (const s of sessions.values()) s.close();
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}
