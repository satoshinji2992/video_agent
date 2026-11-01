const $ = (s) => document.querySelector(s);
const log = $('#log'), scroller = $('#scroller'), input = $('#input'), sendBtn = $('#send'), app = $('#app');
let bots = [], sessions = [], current = null, es = null, typingEl = null, card = null, activity = '', lastRole = null;
/** The last finished progress card, and whether a turn is running (background clips update that card between turns). */
let lastCard = null, inTurn = false;
let pendingImages = [], chosenSkill = null, enabledSkills = [], planState = null, refs = new Map(), searchQ = '';
let pendingApprovals = new Set();
let busy = false, stopping = false, turnStart = 0, lastEventAt = Date.now(), hintKind = 'understand', videos = [];
const knownVersions = {};
/** The version this page was served as; the event stream reports the server's, and a mismatch means a deploy happened. */
const PAGE_VERSION = document.querySelector('meta[name="page-version"]')?.content || '';
let feedback = new Map();
const bubbles = new Map();

const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const seen = ls.get('vbSeen', {});
const markSeen = (id, ts = Date.now()) => { seen[id] = Math.max(seen[id] || 0, ts); ls.set('vbSeen', seen); };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bot = (id) => bots.find((b) => b.id === id) || bots[0];
const icon = (id, size = 18) => `<svg width="${size}" height="${size}"><use href="#i-${id}"/></svg>`;
/** The "Video Bot" wordmark: the name is the logo, there is no picture mark. */
const wordmark = (cls = '') => `<span class="wordmark ${cls}" aria-label="Video Bot"><b>Video</b> <span>Bot</span></span>`;
const money = (n) => `$${(n || 0).toFixed(2)}`;
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toTimeString().slice(0, 5);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  return d.toDateString() === y.toDateString() ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
}
const fmtDateTime = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`; };
const isToday = (ts) => ts && new Date(ts).toDateString() === new Date().toDateString();

/* ---------- toast & status ---------- */
let toastTimer;
function toast(text, { kind = 'warn', onClick = null, action = '查看', ms } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(text)}</span>${onClick ? `<button class="act">${esc(action)}</button>` : ''}`;
  t.hidden = false;
  t.className = `toast ${kind}${onClick ? ' link' : ''}`;
  t.onclick = onClick ? () => { t.hidden = true; onClick(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms ?? (onClick ? 8000 : 4500));
}
async function refreshConfig() {
  try {
    const c = await (await fetch('/api/config')).json();
    $('#statusDot').className = `status-dot ${c.level}`;
    enabledSkills = c.skills || [];
    $('#skillsCount').textContent = `技能 · ${enabledSkills.length} 个`;
    $('#pSkills').innerHTML = enabledSkills.length
      ? enabledSkills.map((s) => `<div class="skill-mini">${icon('spark', 15)}<div><b>${esc(s.name)}</b><span>${esc(s.description)}</span></div></div>`).join('')
      : '<p>未启用技能</p>';
    if (chosenSkill && !enabledSkills.some((s) => s.name === chosenSkill)) { chosenSkill = null; renderChips(); }
  } catch {}
}

/* ---------- sidebar ---------- */
function convRow(s) {
  const unread = s.id !== current?.id && s.updatedAt > (seen[s.id] || 0);
  const title = s.id === renaming ? `<input class="rename" data-rename="${s.id}" maxlength="60" value="${esc(s.title)}">` : `<b>${esc(s.title)}</b>`;
  return `<div class="conv ${s.id === current?.id ? 'active' : ''}" data-id="${s.id}">
    <div class="thumb40" style="${s.thumb ? `background-image:url('${s.thumb}')` : ''}">${s.thumb ? '' : icon('film', 20)}</div>
    <div class="body"><div class="line1">${title}${s.pinned ? `<i class="pinned" title="已置顶">${icon('pin', 13)}</i>` : ''}${s.busy ? '<span class="gen"><i class="spin"></i>生成中</span>' : `<time>${fmtTime(s.updatedAt)}</time>`}</div>
    <div class="line2"><span>${esc(s.preview || ' ')}</span>${unread ? '<i class="dot"></i>' : ''}
    <button class="more" data-more="${s.id}" title="更多" aria-label="更多操作">${icon('more', 16)}</button></div></div></div>`;
}
function renderList() {
  // Re-rendering would throw away a title being typed; the list catches up when renaming ends.
  if (renaming && $('#list').querySelector('.rename')) return;
  const byTime = (a, b) => b.updatedAt - a.updatedAt;
  const groups = [
    ['置顶', sessions.filter((s) => s.pinned).sort(byTime)],
    ['今天', sessions.filter((s) => !s.pinned && isToday(s.updatedAt)).sort(byTime)],
    ['更早', sessions.filter((s) => !s.pinned && !isToday(s.updatedAt)).sort(byTime)],
  ].filter(([, list]) => list.length);
  $('#list').innerHTML = groups.length
    ? groups.map(([name, list]) => `<div class="group">${name}</div>${list.map(convRow).join('')}`).join('')
    : `<div class="empty-list">${searchQ ? '未找到相关对话' : '暂无对话，点击右上角 ✎ 新建'}</div>`;
  const input = $('#list .rename');
  if (input && document.activeElement !== input) { input.focus(); input.select(); }
}

/* ---------- local edits (pin / rename / delete) ----------
   Applied to the list at once and re-applied over every refresh until the server has caught up, so a
   5-second poll that started before the change cannot put the old state back. */
const edits = new Map();
function edit(id, patch) {
  const e = { ...(edits.get(id) || {}), ...patch, doneAt: null };
  edits.set(id, e);
  applyEdits();
  renderList();
  return () => { e.doneAt = Date.now(); };
}
function dropEdit(id) { edits.delete(id); }
function applyEdits(startedAt = Infinity) {
  for (const [id, e] of edits) if (e.doneAt && startedAt > e.doneAt) edits.delete(id);
  sessions = sessions.filter((s) => !edits.get(s.id)?.deleted).map((s) => {
    const e = edits.get(s.id);
    if (!e) return s;
    return { ...s, ...(e.pinned !== undefined ? { pinned: e.pinned } : {}), ...(e.title !== undefined ? { title: e.title } : {}) };
  });
}
async function setPinned(s, pinned) {
  const done = edit(s.id, { pinned });
  try {
    const r = await fetch(`/api/sessions/${s.id}/pin`, { method: 'POST', body: JSON.stringify({ pinned }) });
    if (!r.ok) throw new Error();
    done();
  } catch {
    dropEdit(s.id);
    sessions = sessions.map((x) => (x.id === s.id ? { ...x, pinned: !pinned } : x));
    renderList();
    toast(pinned ? '置顶失败，请重试' : '取消置顶失败，请重试');
  }
}
async function saveTitle(s, title) {
  const before = s.title;
  title = title.trim();
  if (title === before) return;
  const done = edit(s.id, { title: title || before });
  if (current?.id === s.id) { current.title = title || before; if (!busy) presence(); }
  try {
    const r = await fetch(`/api/sessions/${s.id}/title`, { method: 'POST', body: JSON.stringify({ title }) });
    if (!r.ok) throw new Error();
    const j = await r.json();
    edits.get(s.id).title = j.title;
    if (current?.id === s.id) { current.title = j.title; if (!busy) presence(); }
    applyEdits(); renderList();
    done();
  } catch {
    dropEdit(s.id);
    sessions = sessions.map((x) => (x.id === s.id ? { ...x, title: before } : x));
    if (current?.id === s.id) { current.title = before; if (!busy) presence(); }
    renderList();
    toast('重命名失败，请重试');
  }
}
async function deleteConversation(s) {
  const ok = await confirmDialog({
    title: `删除「${s.title}」？`,
    text: '删除后，对话及其成片将移入回收站，7 天内可在“系统 → 回收站”中恢复。',
    ok: '删除', danger: true,
  });
  if (!ok) return;
  const done = edit(s.id, { deleted: true });
  if (current?.id === s.id) {
    if (window.innerWidth <= 760) { history.pushState(null, '', '#/'); toList(); }
    else if (sessions[0]) open(sessions[0].id);
    else newConversation();
  }
  try {
    const r = await fetch(`/api/sessions/${s.id}/delete`, { method: 'POST' });
    if (!r.ok) throw new Error();
    done();
    toast(`已删除「${s.title}」`, { kind: 'ok', action: '撤销', ms: 5000, onClick: () => restoreConversation(s.id, true) });
  } catch {
    dropEdit(s.id);
    refreshList();
    toast('删除失败，请重试');
  }
}
async function restoreConversation(id, reopen) {
  dropEdit(id);
  const r = await fetch(`/api/trash/${id}/restore`, { method: 'POST' }).catch(() => null);
  if (!r?.ok) return toast('恢复失败，请在“系统 → 回收站”中重试');
  await refreshList();
  if (reopen) open(id);
}

/* ---------- conversation menu: ⋯ on desktop, long-press on phones ---------- */
let renaming = null;
const convMenu = $('#convMenu');
function openConvMenu(id, x, y) {
  const s = sessions.find((v) => v.id === id);
  if (!s) return;
  convMenu.dataset.id = id;
  convMenu.innerHTML = `<button data-act="pin">${icon('pin', 16)}${s.pinned ? '取消置顶' : '置顶'}</button>
    <button data-act="rename">${icon('edit', 16)}重命名</button>
    <button data-act="delete" class="danger">${icon('trash', 16)}删除</button>`;
  convMenu.hidden = false;
  const w = convMenu.offsetWidth, h = convMenu.offsetHeight;
  convMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  convMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
}
function closeConvMenu() { convMenu.hidden = true; }
convMenu.onclick = (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const s = sessions.find((v) => v.id === convMenu.dataset.id);
  closeConvMenu();
  if (!s) return;
  if (b.dataset.act === 'pin') setPinned(s, !s.pinned);
  else if (b.dataset.act === 'rename') startRename(s.id);
  else deleteConversation(s);
};
document.addEventListener('pointerdown', (e) => { if (!convMenu.hidden && !convMenu.contains(e.target) && !e.target.closest('[data-more]')) closeConvMenu(); }, true);
document.addEventListener('scroll', closeConvMenu, true);
function startRename(id) {
  renaming = id;
  renderList();
}
function finishRename(input, save) {
  if (renaming !== input.dataset.rename) return;
  const s = sessions.find((v) => v.id === renaming);
  renaming = null;
  if (save && s) saveTitle(s, input.value);
  renderList();
}
$('#list').addEventListener('keydown', (e) => {
  const input = e.target.closest('.rename');
  if (!input) return;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finishRename(input, true); }
  else if (e.key === 'Escape') { e.stopPropagation(); finishRename(input, false); }
});
$('#list').addEventListener('focusout', (e) => { const input = e.target.closest('.rename'); if (input) finishRename(input, true); });

let pressTimer = null, pressed = false;
$('#list').addEventListener('touchstart', (e) => {
  const c = e.target.closest('[data-id]');
  if (!c || e.target.closest('.rename')) return;
  pressed = false;
  const t = e.touches[0];
  pressTimer = setTimeout(() => { pressed = true; navigator.vibrate?.(10); openConvMenu(c.dataset.id, t.clientX - 60, t.clientY + 8); }, 480);
}, { passive: true });
for (const ev of ['touchend', 'touchmove', 'touchcancel']) $('#list').addEventListener(ev, () => clearTimeout(pressTimer), { passive: true });
$('#list').addEventListener('contextmenu', (e) => {
  const c = e.target.closest('[data-id]');
  if (!c || e.target.closest('.rename')) return;
  e.preventDefault();
  if (!pressed) openConvMenu(c.dataset.id, e.clientX, e.clientY);
});
$('#list').onclick = (e) => {
  if (pressed) { pressed = false; return; }
  if (e.target.closest('.rename')) return;
  const more = e.target.closest('[data-more]');
  if (more) {
    e.stopPropagation();
    if (!convMenu.hidden && convMenu.dataset.id === more.dataset.more) return closeConvMenu();
    const r = more.getBoundingClientRect();
    return openConvMenu(more.dataset.more, r.right - 168, r.bottom + 4);
  }
  const c = e.target.closest('[data-id]');
  if (c) open(c.dataset.id);
};

/* ---------- confirm dialog ---------- */
function confirmDialog({ title, text, ok = '确定', danger = false }) {
  const back = $('#confirm');
  back.querySelector('b').textContent = title;
  back.querySelector('p').textContent = text;
  const yes = back.querySelector('.yes');
  yes.textContent = ok;
  yes.classList.toggle('danger', danger);
  back.hidden = false;
  yes.focus();
  return new Promise((resolve) => {
    const close = (v) => { back.hidden = true; back.onclick = null; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(false); } };
    document.addEventListener('keydown', key, true);
    back.onclick = (e) => { if (e.target === back || e.target.closest('.no')) close(false); else if (e.target.closest('.yes')) close(true); };
  });
}

async function refreshList() {
  const startedAt = Date.now();
  try { sessions = (await (await fetch(`/api/sessions${searchQ ? `?q=${encodeURIComponent(searchQ)}` : ''}`)).json()).sessions; } catch {}
  applyEdits(startedAt);
  for (const s of sessions) {
    const before = knownVersions[s.id];
    if (before !== undefined && s.versions > before && s.id !== current?.id) {
      toast(`「${s.title}」第 ${s.versions} 版已生成`, { kind: 'ok', onClick: () => open(s.id) });
    }
    knownVersions[s.id] = s.versions;
  }
  const mine = current && sessions.find((s) => s.id === current.id);
  if (mine && mine.title !== current.title) { current.title = mine.title; if (!busy) presence(); }
  renderList();
  updateTitle();
}
/** Unread conversations in the tab title, e.g. "(1) Video Bot". */
function updateTitle() {
  const n = sessions.filter((s) => s.updatedAt > (seen[s.id] || 0) && (s.id !== current?.id || document.hidden)).length;
  document.title = `${n ? `(${n}) ` : ''}${bots[0]?.name || 'Video Bot'}`;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) { markSeen(current.id); renderList(); }
  updateTitle();
});
let searchTimer;
$('#search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { searchQ = e.target.value.trim(); refreshList(); }, 200); });

/* ---------- chat ---------- */
const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
function scroll(force) { if (force || atBottom()) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight)); }
function add(el, role) {
  const stick = atBottom();
  log.querySelector('.hello')?.remove();
  if (role === 'them' && lastRole === 'them') el.classList.add('cont');
  lastRole = role ?? null;
  log.insertBefore(el, typingEl && typingEl.isConnected ? typingEl : null);
  scroll(stick);
  return el;
}
function row(who, inner) {
  const r = document.createElement('div');
  r.className = 'row ' + who;
  r.innerHTML = inner;
  return r;
}
/** Top bar: the status next to the small wordmark, and the conversation title as the main line. */
function presence(text, live = false) {
  const el = $('#presence');
  el.textContent = text || '';
  el.classList.toggle('live', live);
  const t = $('#convTitle');
  if (!t.querySelector('input')) t.textContent = current?.title || '新对话';
}
// The conversation title renames in place when clicked.
$('#convTitle').addEventListener('click', (e) => {
  const el = $('#convTitle');
  e.stopPropagation();
  if (el.querySelector('input') || !current) return;
  el.innerHTML = `<input class="rename top" maxlength="60" value="${esc(current.title)}" aria-label="对话名称">`;
  const inp = el.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const s = sessions.find((x) => x.id === current?.id) || current;
    el.innerHTML = '';
    presence();
    if (save && s) saveTitle(s, inp.value);
  };
  inp.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
  };
  inp.onblur = () => finish(true);
});
function setTyping(on) {
  busy = on;
  app.classList.toggle('busy', on);
  if (!on) stopping = false;
  presence(on ? (stopping ? '正在停止' : activity || '正在输入…') : '', on);
  if (on && !typingEl) {
    typingEl = row('them', '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span><span class="think"></span></div>');
    log.appendChild(typingEl); scroll();
  } else if (!on && typingEl) { typingEl.remove(); typingEl = null; activity = ''; }
  input.placeholder = on ? '可继续输入新的要求' : '描述你想生成的视频';
  updateSend();
}

/* ---------- progress card ---------- */
const STAGES = [['understand', '需求分析'], ['skill', '查阅技能'], ['plan', '分镜规划'], ['shots', '镜头制作'], ['assemble', '合成'], ['check', '质检']];
/** A turn that writes a script has its own steps; it ends waiting for the user's confirmation. */
const SCRIPT_STAGES = [['understand', '需求分析'], ['research', '查资料'], ['script', '写剧本'], ['confirm', '剧本待确认']];
const HINTS = {
  understand: '需求分析耗时较长，请稍候', skill: '技能资料查阅耗时较长，请稍候', plan: '分镜规划耗时较长，请稍候',
  shots: '镜头较复杂，编写耗时较长，请稍候', seedance: '写实镜头生成通常需要 1–2 分钟',
  assemble: '合成即将完成，请稍候', check: '成片检查中，请稍候',
  research: '资料查询耗时较长，请稍候', script: '剧本编写耗时较长，请稍候', confirm: '',
};
const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

function ensureCard(first) {
  if (card && !card.dataset.done) return card;
  const scripting = ['research', 'script', 'confirm'].includes(first);
  const stages = scripting ? SCRIPT_STAGES : STAGES.filter(([k]) => k !== 'skill' || enabledSkills.length || refs.size);
  card = row('them', `<div class="card work"><div class="head"><b>准备中</b><span class="elapsed"></span></div>
    <div class="steps">${stages.map(([k, l]) => `<div class="step" data-s="${k}"><i></i><span>${l}</span></div>`).join('')}</div><div class="stepline"></div>
    <div class="refs" hidden></div><div class="plan" hidden><div class="sub"></div><div class="shots"></div></div>
    <div class="status"><span class="now"></span><span class="idlehint"></span></div></div>`);
  card.dataset.start = turnStart || Date.now();
  // A turn that continues the same video (e.g. started when background clips finished) keeps its title.
  const prevTitle = lastCard?.querySelector('.head b')?.textContent;
  if (prevTitle && prevTitle !== '准备中') card.querySelector('.head b').textContent = prevTitle;
  card.visited = new Set(['understand']);
  add(card, 'them');
  setStep('understand');
  return card;
}
function setStep(stage) {
  if (!card) return;
  card.dataset.stage = stage;
  card.visited.add(stage);
  const steps = [...card.querySelectorAll('.step')];
  const cur = steps.findIndex((s) => s.dataset.s === stage);
  steps.forEach((s, i) => {
    s.className = 'step' + (i < cur ? (card.visited.has(s.dataset.s) ? ' done' : ' skip') : i === cur ? ' on' : '');
  });
  renderShotCount();
}
/** "做镜头 2/5" on the step, plus the one-line step summary that replaces the labels on phones. */
function renderShotCount() {
  const el = card?.querySelector('.step[data-s="shots"] span');
  if (!el) return;
  const shots = planState?.shots || [];
  el.textContent = shots.length ? `镜头制作 ${shots.filter((s) => s.status === 'ready').length}/${shots.length}` : '镜头制作';
  const steps = [...card.querySelectorAll('.step')];
  const cur = steps.findIndex((s) => s.dataset.s === card.dataset.stage);
  if (cur >= 0) card.querySelector('.stepline').textContent = `第 ${cur + 1}/${steps.length} 步 · ${steps[cur].querySelector('span').textContent}`;
}
function setNow(t) { if (card && !card.dataset.done) card.querySelector('.status .now').textContent = t; }
function finishCard(how, ts) {
  if (card) lastCard = card;
  if (!card || card.dataset.done) return;
  card.dataset.done = '1';
  const c = card.querySelector('.card');
  c.classList.add(how === 'video' ? 'done' : 'ended');
  if (how === 'video') { card.querySelectorAll('.step').forEach((s) => (s.className = s.classList.contains('skip') ? 'step skip' : 'step done')); card.querySelector('.stepline').textContent = '已完成'; }
  card.querySelector('.status .now').textContent =
    { video: `第 ${card.dataset.version} 版已生成`, stopped: '已停止，已完成的镜头已保留', error: '本轮未完成', background: '写实镜头在后台拍，好一个发一个', partial: card.dataset.stage === 'confirm' ? '剧本待确认' : '本轮已结束', lost: '本轮已中断' }[how] || '';
  card.querySelector('.status .idlehint').textContent = '';
  card.querySelector('.elapsed').textContent = `用时 ${fmtDur((ts || Date.now()) - Number(card.dataset.start))}`;
}

/** A finished card whose realistic shots are still coming in: counts down as they arrive. */
function setBackground(e) {
  const left = Math.max(0, Number(card.dataset.bg) - 1);
  card.dataset.bg = String(left);
  if (e.ok === false) card.dataset.bgFailed = String(Number(card.dataset.bgFailed || 0) + 1);
  const failed = Number(card.dataset.bgFailed || 0);
  card.querySelector('.status .now').textContent = left ? `写实镜头还有 ${left} 个在拍` : failed ? `写实镜头都结束了，${failed} 个没拍成` : '写实镜头都拍好了';
}

function shotHtml(s) {
  const label = { planned: '等待中', working: s.kind === 'seedance' ? '生成中' : '制作中', ready: `${s.seconds} 秒`, failed: '未完成' }[s.status] || s.status;
  return `<div class="thumb" style="${s.thumb ? `background-image:url('${s.thumb}')` : ''}"><span class="kind">${{ seedance: '写实', '3d': '3D', image: '图片', footage: '实拍' }[s.kind] || '动画'}${s.role && s.role !== 'main' ? ` · ${{ broll: 'B-roll', pip: '画中画', source: '分屏' }[s.role]}` : ''}</span>${s.clip ? `<span class="playmark">${icon('play', 14)}</span>` : ''}</div><div class="lbl">${esc(label)}</div>`;
}
/** Updates shot tiles in place, so a tile lights up (CSS transition) when its shot is ready. */
function renderShots(box, shots) {
  const old = new Map([...box.children].map((el) => [el.dataset.id, el]));
  box.replaceChildren(...shots.map((s) => {
    const el = old.get(s.id) || Object.assign(document.createElement('button'), { type: 'button' });
    el.className = `shot ${s.status}`;
    el.dataset.id = s.id;
    el.title = s.brief || '';
    if (s.clip) el.dataset.clip = s.clip; else delete el.dataset.clip;
    el.dataset.caption = `镜头 ${s.id} · ${s.seconds} 秒 · ${s.brief || ''}`;
    const html = shotHtml(s);
    if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
    return el;
  }));
}
function refsText() {
  const parts = [...refs].map(([skill, items]) => (items.size ? `${skill} · ${[...items].slice(0, 3).join('、')}` : skill));
  return parts.length ? `参考技能：${parts.join('；')}` : '';
}
function renderRefs() {
  if (!card) return;
  const el = card.querySelector('.refs');
  const t = refsText();
  el.hidden = !t;
  el.innerHTML = t ? `${icon('spark', 13)}<span>${esc(t)}</span>` : '';
}
function renderPlan(e) {
  planState = e;
  // Between turns (a background clip just landed) the update belongs on the last finished card, not a new one.
  if (!card && !inTurn) { card = lastCard; if (!card) return; }
  if (!card) ensureCard();
  card.querySelector('.head b').textContent = e.title || '未命名';
  card.dataset.aspect = e.aspect;
  const plan = card.querySelector('.plan');
  plan.hidden = false;
  plan.querySelector('.sub').textContent = `${e.shots.length} 个镜头 · ${e.seconds} 秒 · ${e.aspect}`;
  renderShots(plan.querySelector('.shots'), e.shots);
  renderShotCount();
  renderRefs();
  scroll();
}

/* ---------- script card ---------- */
const LANG = { en: '英文口播', zh: '中文口播', none: '无口播' };
const fmtSec = (x) => `${Math.round(x * 10) / 10}`;
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
function scriptHtml(e) {
  const changed = new Set(e.changed || []);
  const revised = e.version > 1 && changed.size > 0;
  const seg = (g) => `<li class="seg${changed.has(g.id) ? ' changed' : ''}${revised && !changed.has(g.id) ? ' same' : ''}">
    <div class="seg-top"><span class="tcap">${fmtSec(g.start)}–${fmtSec(g.end)} 秒</span><span class="role">${esc(g.role)}</span>${g.kind_hint ? `<span class="khint">${esc(g.kind_hint)}</span>` : ''}${revised && changed.has(g.id) ? '<span class="chg">已修改</span>' : ''}</div>
    <div class="seg-row"><label>画面</label><p>${esc(g.visual)}</p></div>
    ${g.vo ? `<div class="seg-row vo"><label>口播</label><p>“${esc(g.vo)}”</p></div>` : ''}
    ${g.caption ? `<div class="seg-row"><label>字幕</label><p>${esc(g.caption)}</p></div>` : ''}</li>`;
  const sameCount = revised ? e.segments.filter((g) => !changed.has(g.id)).length : 0;
  const sources = (e.sources || []).filter((x) => safeUrl(x.url));
  return `<div class="script-card${revised ? ' revised' : ''}">
    <div class="sc-head"><b>${esc(e.title)}</b><span class="sc-ver">第 ${e.version} 版</span></div>
    <div class="sc-meta">约 ${e.total_seconds} 秒 · ${esc(e.aspect)} · ${esc(LANG[e.vo_language] || `${e.vo_language} 口播`)}${e.style ? ` · ${esc(e.style)}` : ''}</div>
    ${e.insight ? `<div class="sc-insight">${icon('spark', 13)}<span>${esc(e.insight)}</span></div>` : ''}
    <ol class="sc-segs">${e.segments.map(seg).join('')}</ol>
    ${sameCount ? `<button class="sc-more" type="button" data-n="${sameCount}">展开其余 ${sameCount} 段（未修改）</button>` : ''}
    ${sources.length ? `<details class="sc-sources"><summary>参考了 ${sources.length} 个来源</summary><ul>${sources.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || x.url)}</a></li>`).join('')}</ul></details>` : ''}
  </div>`;
}

/* ---------- question card ---------- */
let openAsks = [];
function askHtml(e) {
  openAsks.push(e.id);
  if (e.questions) {
    // A brief card: one group per question, the first (recommended) option preselected.
    return `<div class="ask-card form" data-ask="${esc(e.id)}">
      <div class="ask-q">${esc(e.question)}</div>
      ${e.questions.map((q, qi) => `<div class="ask-group" data-q="${qi}" data-label="${esc(q.label)}"><div class="ask-label">${esc(q.label)}</div>${q.options
        ? `<div class="ask-chips">${q.options.map((o, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-i="${i}" data-text="${esc(o)}">${esc(o)}${i === 0 ? '<span class="rec-dot" title="推荐"></span>' : ''}</button>`).join('')}</div>`
        : `<input class="ask-input" type="text" maxlength="40" placeholder="${esc(q.input || '')}">`}</div>`).join('')}
      <div class="ask-actions"><button type="button" class="btn ask-rec">就按推荐来</button><button type="button" class="btn primary ask-send">确定</button></div>
    </div>`;
  }
  return `<div class="ask-card ${e.mode === 'suggest' ? 'suggest' : ''}" data-ask="${esc(e.id)}">
    <div class="ask-q">${esc(e.question)}</div>
    <div class="ask-opts">${e.options.map((o, i) => `<button type="button" class="opt${e.recommended === i ? ' rec' : ''}" data-i="${i}" data-text="${esc(o)}"><span class="letter">${String.fromCharCode(65 + i)}</span><span class="t">${esc(o)}</span>${e.recommended === i ? '<span class="rec-tag">推荐</span>' : ''}</button>`).join('')}</div>
  </div>`;
}
/** A new user message closes the open question cards: the picked option stays marked, the rest dim. */
function settleAsks(answer) {
  for (const id of openAsks) {
    const box = log.querySelector(`.ask-card[data-ask="${CSS.escape(id)}"]`);
    if (!box) continue;
    box.classList.add('closed');
    if (answer?.id === id) box.querySelector(`.opt[data-i="${answer.index}"]`)?.classList.add('picked');
    if (answer?.id === id && answer.picks) {
      box.querySelectorAll('.ask-group').forEach((g, qi) => g.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', Number(c.dataset.i) === answer.picks[qi])));
    }
  }
  openAsks = [];
}
log.addEventListener('click', async (e) => {
  const more = e.target.closest('.sc-more');
  if (more) {
    const open = more.closest('.script-card').classList.toggle('expanded');
    more.textContent = open ? '收起未修改的段' : `展开其余 ${more.dataset.n} 段（未修改）`;
    return;
  }
  const chip = e.target.closest('.ask-card.form:not(.closed) .chip');
  if (chip) {
    chip.closest('.ask-chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    return;
  }
  const send = e.target.closest('.ask-card.form:not(.closed) .ask-send, .ask-card.form:not(.closed) .ask-rec');
  if (send) {
    const box = send.closest('.ask-card');
    const groups = [...box.querySelectorAll('.ask-group')];
    // "就按推荐来" takes the first option of every question, whatever was tapped.
    if (send.classList.contains('ask-rec')) groups.forEach((g) => g.querySelectorAll('.chip').forEach((c, i) => c.classList.toggle('on', i === 0)));
    // A fill-in field counts as -1 in picks; left empty it is left out of the message.
    const picks = groups.map((g) => (g.querySelector('.ask-input') ? -1 : Number(g.querySelector('.chip.on')?.dataset.i ?? 0)));
    const text = groups.map((g, i) => {
      const input = g.querySelector('.ask-input');
      if (input) return input.value.trim() ? `${g.dataset.label}：${input.value.trim()}` : '';
      return `${g.dataset.label}：${g.querySelectorAll('.chip')[picks[i]].dataset.text}`;
    }).filter(Boolean).join('；');
    if (!text) return;
    box.classList.add('closed');
    openAsks = openAsks.filter((x) => x !== box.dataset.ask);
    const ok = await postMessage(text, { answer: { id: box.dataset.ask, picks } });
    if (!ok) { box.classList.remove('closed'); openAsks.push(box.dataset.ask); }
    return;
  }
  const opt = e.target.closest('.ask-card:not(.closed) .opt');
  if (!opt) return;
  const box = opt.closest('.ask-card');
  box.classList.add('closed');
  opt.classList.add('picked');
  openAsks = openAsks.filter((x) => x !== box.dataset.ask);
  const ok = await postMessage(opt.dataset.text, { answer: { id: box.dataset.ask, index: Number(opt.dataset.i) } });
  if (!ok) { box.classList.remove('closed'); opt.classList.remove('picked'); openAsks.push(box.dataset.ask); }
});

/* ---------- approvals ---------- */
function renderApproval(e, live) {
  const r = row('them', `<div class="approval" data-aid="${esc(e.id)}" data-exp="${e.expiresAt || e.ts + 600000}"><div class="label">需要确认</div><b>${esc(e.title)}</b><p>${esc(e.detail)}</p>
    <div class="btns"><button class="btn primary yes">允许一次</button><button class="btn no">拒绝</button></div><div class="countdown"></div><div class="result" hidden></div></div>`);
  add(r, 'them');
  if (!live && !pendingApprovals.has(e.id)) closeApproval(r.querySelector('.approval'), null, 'stale');
  else tickApprovals();
}
function closeApproval(box, ok, reason) {
  if (box.classList.contains('closed')) return;
  box.classList.add('closed');
  box.querySelector('.btns')?.remove();
  box.querySelector('.countdown')?.remove();
  const expired = reason === 'expired' || (reason === 'stale' && Date.now() > Number(box.dataset.exp));
  box.classList.toggle('expired', expired);
  const res = box.querySelector('.result');
  res.hidden = false;
  res.textContent = expired ? '已超时，未重新生成' : reason === 'stale' ? '已失效' : ok ? '已允许' : '已拒绝';
}
function tickApprovals() {
  for (const box of log.querySelectorAll('.approval:not(.closed)')) {
    const left = Number(box.dataset.exp) - Date.now();
    if (left <= 0) closeApproval(box, false, 'expired');
    else box.querySelector('.countdown').textContent = `${fmtDur(left)} 后未选择将视为拒绝`;
  }
}

/* ---------- versions ---------- */
function showVersion(box, n) {
  const v = videos.find((x) => x.n === n) || videos.at(-1);
  if (!v) return;
  box.className = `videobox ${{ '16:9': 'wide', '1:1': 'square' }[v.aspect] || ''}`;
  box.dataset.v = v.n;
  const video = box.querySelector('video');
  if (video.getAttribute('src') !== v.url) { video.poster = v.poster; video.src = v.url; }
  box.querySelector('.meta span').innerHTML = `<b>第 ${v.n} 版</b> · ${v.seconds} 秒`;
  renderFeedback(box, v.n);
  const a = box.querySelector('.meta a');
  a.href = v.url; a.download = `video-v${v.n}.mp4`;
  const tabs = box.querySelector('.vtabs');
  tabs.hidden = videos.length < 2;
  tabs.innerHTML = videos.length < 2 ? '' : videos.map((x) => `<button data-v="${x.n}" class="${x.n === v.n ? 'on' : ''}">v${x.n}</button>`).join('');
}
function foldVideo(box) {
  const v = videos.find((x) => x.n === Number(box.dataset.orig));
  if (!v) return;
  box.className = 'videobox folded';
  box.innerHTML = `<button class="vfold" data-v="${v.n}"><span class="pthumb" style="background-image:url('${v.poster}')">${icon('play', 12)}</span><span><b>第 ${v.n} 版</b> · ${v.seconds} 秒</span><span class="go">在播放器中查看</span></button>`;
}
function addVideo(e) {
  videos.push({ n: e.version, url: e.url, poster: e.poster, seconds: e.seconds, aspect: e.aspect || card?.dataset.aspect || '9:16' });
  log.querySelectorAll('.videobox:not(.folded)').forEach(foldVideo);
  const r = row('them', `<div class="videobox" data-orig="${e.version}"><div class="vtabs" hidden></div><video controls playsinline preload="metadata"></video>
    <div class="meta"><span></span><span class="rate"><button data-rate="up" title="满意" aria-label="满意">${icon('up', 16)}</button><button data-rate="down" title="不满意" aria-label="不满意">${icon('down', 16)}</button></span><a>${icon('download', 15)}下载</a></div>
    <div class="fbform" hidden></div></div>`);
  add(r, 'them');
  showVersion(r.querySelector('.videobox'), e.version);
}

/* ---------- 👍 / 👎 on a version ---------- */
function renderFeedback(box, n) {
  const f = feedback.get(n);
  box.querySelectorAll('[data-rate]').forEach((b) => b.classList.toggle('on', f?.rating === b.dataset.rate));
  const form = box.querySelector('.fbform');
  if (!form) return;
  const asking = f && box.dataset.asking === String(n);
  const state = asking ? `ask:${n}:${f.rating}` : f?.comment ? `said:${n}:${f.rating}:${f.comment}` : '';
  // The server echoes every rating back; leave a remark that is being typed alone.
  if (form.dataset.state === state) return;
  form.dataset.state = state;
  if (asking) {
    form.hidden = false;
    form.innerHTML = `<input maxlength="200" value="${esc(f.comment || '')}" placeholder="${f.rating === 'up' ? '满意之处（选填）' : '不满意之处（选填）'}"><button class="btn sm">发送</button>`;
  } else if (f?.comment) { form.hidden = false; form.innerHTML = `<span class="said">${icon(f.rating, 13)}${esc(f.comment)}</span>`; }
  else { form.hidden = true; form.innerHTML = ''; }
}
async function sendFeedback(box, rating, comment = '') {
  const n = Number(box.dataset.v);
  const prev = feedback.get(n);
  feedback.set(n, { rating, comment });
  if (!comment) box.dataset.asking = String(n);
  renderFeedback(box, n);
  if (!comment) box.querySelector('.fbform input')?.focus();
  const r = await fetch(`/api/sessions/${current.id}/feedback`, { method: 'POST', body: JSON.stringify({ version: n, rating, comment }) }).catch(() => null);
  if (!r?.ok) {
    if (prev) feedback.set(n, prev); else feedback.delete(n);
    renderFeedback(box, n);
    toast('评价提交失败，请重试');
  }
}
log.addEventListener('click', (e) => {
  const rate = e.target.closest('[data-rate]');
  if (rate) {
    const box = rate.closest('.videobox');
    const n = Number(box.dataset.v);
    if (feedback.get(n)?.rating === rate.dataset.rate) {
      // Same rating again: just reopen the remark box instead of sending a duplicate.
      box.dataset.asking = String(n);
      renderFeedback(box, n);
      return box.querySelector('.fbform input')?.focus();
    }
    return sendFeedback(box, rate.dataset.rate);
  }
  const send = e.target.closest('.fbform button');
  if (send) {
    const box = send.closest('.videobox');
    const text = box.querySelector('.fbform input').value.trim();
    const f = feedback.get(Number(box.dataset.v));
    if (text && f) { box.dataset.asking = ''; sendFeedback(box, f.rating, text); }
  }
});
log.addEventListener('keydown', (e) => {
  const inp = e.target.closest('.fbform input');
  if (inp && e.key === 'Enter' && !e.isComposing) { e.preventDefault(); inp.nextElementSibling.click(); }
});

/* ---------- trajectory panel ---------- */
const traj = $('#traj');
let trajTimer = null, trajSig = '';
const SCORE_NAMES = [['speed', '速度'], ['naturalness', '自然度'], ['adherence', '遵循度'], ['quality', '成片质量'], ['judgment', '剧本与判断']];
const STAGE_LABEL = { understand: '需求分析', research: '查资料', script: '写剧本', confirm: '剧本待确认', skill: '查阅技能', plan: '分镜规划', shots: '镜头制作', assemble: '合成', check: '质检' };
const relT = (ms) => `+${fmtDur(ms)}`;
const usd = (n) => `$${(n || 0).toFixed(n && n < 0.1 ? 3 : 2)}`;
function scoreChips(sc) {
  return SCORE_NAMES.map(([k, l]) => (sc[k] == null ? `<span class="sc na">${l} —</span>` : `<span class="sc s${sc[k]}">${l} ${sc[k]}</span>`)).join('');
}
function openTraj(open) {
  traj.classList.toggle('open', open);
  $('#scrim').classList.toggle('open', open || $('#profile').classList.contains('open'));
  clearInterval(trajTimer);
  if (open) { loadTraj(); trajTimer = setInterval(() => loadTraj(true), 5000); }
}
async function loadTraj(quiet) {
  if (!current) return;
  const id = current.id;
  $('#trajDownload').href = `/api/sessions/${id}/trajectory.jsonl`;
  if (!quiet) $('#trajBody').innerHTML = '<p class="note">加载中…</p>';
  let j;
  try {
    const r = await fetch(`/api/sessions/${id}/trajectory`);
    j = r.ok ? await r.json() : null;
  } catch {}
  if (current?.id !== id || !traj.classList.contains('open')) return;
  if (!Array.isArray(j?.turns)) { if (!quiet) $('#trajBody').innerHTML = '<p class="note">加载失败，请稍后重试</p>'; return; }
  // Re-render only when something changed, and keep opened details and the scroll position when it does.
  const sig = JSON.stringify(j);
  if (quiet && sig === trajSig) return;
  trajSig = sig;
  const body = $('#trajBody');
  const opened = new Set([...body.querySelectorAll('details[open][data-k]')].map((d) => d.dataset.k));
  const top = body.scrollTop;
  const scored = j.turns.filter((t) => t.review);
  $('#trajSub').textContent = `${j.turns.length} 轮${scored.length ? ` · 已点评 ${scored.length}` : ''}`;
  $('#trajDownload').hidden = !j.turns.length;
  body.innerHTML = j.turns.length ? j.turns.slice().reverse().map((t) => turnHtml(t, j)).join('') : '<p class="note">暂无轨迹</p>';
  body.querySelectorAll('details[data-k]').forEach((d) => { if (opened.has(d.dataset.k)) d.open = true; });
  if (quiet) body.scrollTop = top;
}
function turnHtml(t, j) {
  const dur = t.end ? t.end - t.start : Date.now() - t.start;
  const firstStage = t.events.find((e) => e.kind === 'stage');
  const stages = [['understand', firstStage ? firstStage.t : dur], ...t.stages.map((s) => [s.stage, s.ms])].filter(([, ms]) => ms > 0);
  const review = t.review
    ? `<div class="rv"><div class="scores">${scoreChips(t.review.scores)}</div><p>${esc(t.review.comments)}</p></div>`
    : !t.end ? ''
    : j.pendingIds.includes(t.id) ? '<div class="rv muted"><i class="spin"></i> 点评生成中…</div>'
    : t.reviewError ? `<div class="rv muted">点评失败：${esc(t.reviewError)}</div>`
    : !j.reviewEnabled ? '<div class="rv muted">自动点评已关闭</div>' : '<div class="rv muted">无点评</div>';
  const fbs = t.feedback.map((f) => `<div class="fbk ${f.rating}">${icon(f.rating, 13)}第 ${f.version} 版${f.comment ? `：${esc(f.comment)}` : ''}</div>`).join('');
  const rows = t.events.map((e) => {
    const at = `<time>${relT(e.t)}</time>`;
    if (e.kind === 'tool') {
      const brief = (e.args || []).filter((a) => !a.long).map((a) => `${esc(a.key)}=${esc(a.value.length > 40 ? a.value.slice(0, 40) + '…' : a.value)}`).join(' ');
      const argRows = (e.args || []).map((a) => a.long
        ? `<details class="arg" data-k="${esc(`${t.id}:${e.id}:${a.key}`)}"><summary>${esc(a.key)} <small>${a.value.length.toLocaleString()} 字</small></summary><pre>${esc(a.value)}</pre></details>`
        : `<div class="arg"><b>${esc(a.key)}</b> <code>${esc(a.value)}</code></div>`).join('');
      const state = e.denied ? '<span class="st bad">被拒绝</span>'
        : e.ms == null ? `<span class="st">${t.end ? '无结果' : '进行中'}</span>`
        : `<span class="st${e.failed ? ' bad' : ''}">${e.failed ? '失败 · ' : ''}${(e.ms / 1000).toFixed(1)}s</span>`;
      return `<li class="ev tool${e.denied || e.failed ? ' denied' : ''}"><details data-k="${esc(`${t.id}:${e.id}`)}"><summary>${at}<b>${esc(e.tool)}</b><span class="brief">${brief}</span>${state}</summary>
        <div class="detail">${argRows || '<div class="arg muted">无参数</div>'}${e.denied ? `<div class="deny">${esc(e.denied)}</div>` : ''}${e.output ? `<div class="out"><b>${e.failed ? '错误' : '结果'}</b><pre>${esc(e.output)}</pre></div>` : ''}</div></details></li>`;
    }
    if (e.kind === 'stage') return `<li class="ev stage">${at}<span>▸ ${esc(e.text)}</span></li>`;
    if (e.kind === 'bot') return `<li class="ev bot">${at}<span>${esc(e.text)}</span></li>`;
    if (e.kind === 'script' || e.kind === 'ask') return `<li class="ev misc">${at}<span>${esc(e.text)}</span></li>`;
    if (e.kind === 'narration') return `<li class="ev narration">${at}<span>${esc(e.text)}<small>未显示</small></span></li>`;
    if (e.kind === 'video') return `<li class="ev video">${at}<span>${icon('film', 14)}${esc(e.text)}</span></li>`;
    return `<li class="ev misc">${at}<span>${esc(e.text)}</span></li>`;
  }).join('');
  const tok = t.tokens ? ` · 输入 ${Math.round((t.tokens.input + t.tokens.cacheRead) / 1000)}k / 输出 ${(t.tokens.output / 1000).toFixed(1)}k tokens` : '';
  return `<section class="turn"><header><b>第 ${t.index} 轮</b><span>${fmtDateTime(t.start)} · ${t.end ? `用时 ${fmtDur(dur)}` : '进行中'}${t.stopped ? ' · 已停止' : t.ok === false ? ' · 出错' : ''}</span></header>
    <blockquote>${t.user.skill ? `<span class="skilltag">${icon('spark', 11)}${esc(t.user.skill)}</span> ` : ''}${esc(t.user.text || '（仅图片）')}${t.user.images ? ` <small>+${t.user.images} 张图片</small>` : ''}</blockquote>
    ${review}${fbs}
    <div class="stagebar">${stages.map(([k, ms]) => `<span>${STAGE_LABEL[k] || k} ${fmtDur(ms)}</span>`).join('')}</div>
    <ol class="tl">${rows}</ol>
    <div class="cost">Claude ≈ ${usd(t.claudeUsd)}（估算） · 写实镜头 ${usd(t.seedanceUsd)}${tok}${t.review ? ` · 点评 ${usd(t.review.costUsd)}` : ''}</div></section>`;
}
$('#trajBtn').onclick = () => { openProfile(false); openTraj(true); };
$('#closeTraj').onclick = () => openTraj(false);
$('#trajRefresh').onclick = () => loadTraj();

/* ---------- lightbox ---------- */
function preview(url, caption, kind = 'video') {
  const lb = $('#lightbox');
  const video = lb.querySelector('video'), img = lb.querySelector('img');
  video.hidden = kind !== 'video'; img.hidden = kind !== 'image';
  if (kind === 'video') video.src = url; else img.src = url;
  lb.querySelector('.cap').textContent = caption || '';
  lb.hidden = false;
}
function closePreview() { const lb = $('#lightbox'); lb.hidden = true; lb.querySelector('video').removeAttribute('src'); lb.querySelector('img').removeAttribute('src'); }
$('#lightbox').onclick = (e) => { if (!e.target.closest('video')) closePreview(); };

/* ---------- background results ---------- */
/** One realistic shot finished in the background: named by what it shows, with a playable preview. */
function shotReadyHtml(e) {
  if (!e.ok) return `<div class="bg-item failed"><div class="bg-text"><b>${esc(e.brief)}</b>没拍成${e.error ? `：${esc(e.error)}` : ''}</div></div>`;
  return `<div class="bg-item"><button type="button" class="bg-thumb" data-clip="${esc(e.clip || '')}" data-caption="${esc(e.brief)}" style="${e.thumb ? `background-image:url('${esc(e.thumb)}')` : ''}"><span class="playmark">${icon('play', 14)}</span></button>
    <div class="bg-text"><b>${esc(e.brief)}</b>拍好了${e.seconds ? `<small>${e.seconds} 秒</small>` : ''}${e.note ? `<small class="note">${esc(e.note)}</small>` : ''}</div></div>`;
}
/** What happened while the conversation was closed: counts and the newest result only. */
function awayHtml(e) {
  const parts = [e.shots ? `拍好 ${e.shots} 个镜头` : '', e.failed ? `${e.failed} 个没拍成` : '', e.versions?.length ? `出了第 ${e.versions.join('、')} 版` : '', e.pending ? `还有 ${e.pending} 个在拍` : ''].filter(Boolean);
  const l = e.latest;
  const media = !l ? '' : l.kind === 'video'
    ? `<button type="button" class="bg-thumb" data-clip="${esc(l.url || '')}" data-caption="第 ${esc(String(l.version))} 版" style="${l.poster ? `background-image:url('${esc(l.poster)}')` : ''}"><span class="playmark">${icon('play', 14)}</span></button>`
    : `<button type="button" class="bg-thumb" data-clip="${esc(l.clip || '')}" data-caption="${esc(l.brief || '')}" style="${l.thumb ? `background-image:url('${esc(l.thumb)}')` : ''}"><span class="playmark">${icon('play', 14)}</span></button>`;
  return `<div class="bg-item away">${media}<div class="bg-text"><b>你离开期间</b>${esc(parts.join('，'))}${l ? `<small>最新：${esc(l.kind === 'video' ? `第 ${l.version} 版成片` : l.brief || '')}</small>` : ''}</div></div>`;
}

/* ---------- generated images ---------- */
function imagesHtml(e) {
  return `<div class="images-card${e.files.length === 1 ? ' one' : ''}">${e.files.map((f, i) => `<figure>
    <button type="button" class="img-open" data-src="${esc(f.url)}" data-cap="${esc(`第 ${i + 1} 张 · ${f.width}×${f.height}`)}" style="aspect-ratio:${f.width}/${f.height}"><img src="${esc(f.url)}" alt="" loading="lazy"></button>
    <figcaption><span>${f.width}×${f.height}</span><a href="${esc(f.url)}" download="${esc(f.name)}">${icon('download', 14)}下载</a></figcaption></figure>`).join('')}</div>`;
}

log.addEventListener('click', async (e) => {
  const shot = e.target.closest('.shot[data-clip], .bg-thumb[data-clip]');
  if (shot) return preview(shot.dataset.clip, shot.dataset.caption);
  const im = e.target.closest('.img-open');
  if (im) return preview(im.dataset.src, im.dataset.cap, 'image');
  const tab = e.target.closest('.vtabs [data-v]');
  if (tab) return showVersion(tab.closest('.videobox'), Number(tab.dataset.v));
  const fold = e.target.closest('.vfold');
  if (fold) {
    const latest = [...log.querySelectorAll('.videobox:not(.folded)')].at(-1);
    if (latest) { showVersion(latest, Number(fold.dataset.v)); latest.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return;
  }
  const btn = e.target.closest('.approval button');
  if (!btn || !current) return;
  const box = btn.closest('.approval');
  box.querySelectorAll('button').forEach((b) => (b.disabled = true));
  const r = await fetch(`/api/sessions/${current.id}/approvals/${box.dataset.aid}`, { method: 'POST', body: JSON.stringify({ ok: btn.classList.contains('yes') }) });
  if (!r.ok) closeApproval(box, null, 'stale');
});

/** Renders one event; one that fails (a card this page does not know yet) leaves a line instead of breaking the rest. */
function handle(e, live = true) {
  try { handleEvent(e, live); } catch (err) {
    console.error('render failed', e?.type, err);
    if (['ask', 'script', 'plan', 'images', 'shot_ready', 'away', 'media_batch', 'file', 'approval', 'video', 'feedback'].includes(e?.type)) {
      const r = add(row('them', '<button type="button" class="sys stale-card">这里有一张新卡片，刷新页面后可见</button>'), 'them');
      r?.querySelector?.('.stale-card')?.addEventListener('click', () => location.reload());
      scroll();
    }
  }
}
/** A newer page is out: reload now if nothing would be lost, otherwise offer it in a bar that stays. */
function pageOutdated() {
  const askTyped = [...log.querySelectorAll('.ask-card:not(.closed) .ask-input')].some((i) => i.value.trim());
  const idle = !input.value.trim() && !pendingImages.length && !uploads.some((f) => !f.done && !f.aborted && !f.failed) && !askTyped;
  if (idle) return location.reload();
  if ($('#updateBar')) return;
  const bar = Object.assign(document.createElement('button'), { id: 'updateBar', type: 'button', className: 'update-bar', textContent: '页面已更新，点此刷新' });
  bar.addEventListener('click', () => location.reload());
  document.body.append(bar);
}
function handleEvent(e, live = true) {
  lastEventAt = live ? Date.now() : e.ts || lastEventAt;
  switch (e.type) {
    case 'user': {
      const imgs = (e.images || []).map((u) => `<img src="${u}" alt="">`).join('');
      const tag = e.skill ? `<span class="skilltag">${icon('spark', 12)}${esc(e.skill)}</span>\n` : '';
      // Many attached files read as a count after the first few.
      const all = e.files || [];
      const files = all.slice(0, 6).map((f) => `<span class="skilltag">${icon({ video: 'film', audio: 'music', image: 'image' }[f.kind] || 'file', 12)}${esc(f.name.split('/').pop())}</span>`).join(' ') + (all.length > 6 ? ` <span class="skilltag">等 ${all.length} 个文件</span>` : '');
      const r = row('me', `<div class="mecol"><div class="bubble">${imgs}${tag}${files ? `${files}\n` : ''}${esc(e.text || '')}</div>${e.queued ? '<div class="qtag">排队中，将在当前任务完成后处理</div>' : ''}</div>`);
      if (e.id) r.dataset.uid = e.id;
      add(r, 'me');
      settleAsks(e.answer);
      if (!e.queued) turnStart = e.ts;
      scroll(true);
      break;
    }
    case 'turn_start': {
      inTurn = true;
      turnStart = e.ts;
      finishCard('lost', e.ts);
      card = null; planState = null; refs = new Map();
      log.querySelector(`.row[data-uid="${CSS.escape(e.id)}"] .qtag`)?.remove();
      break;
    }
    case 'bubble_start': { const r = row('them', '<div class="bubble"></div>'); r.hidden = true; bubbles.set(e.id, r); add(r, 'them'); break; }
    case 'delta': { const r = bubbles.get(e.id); if (r) { const b = r.querySelector('.bubble'); b.textContent += e.text; r.hidden = !b.textContent.trim(); scroll(); } break; }
    case 'bubble_end': {
      let r = bubbles.get(e.id);
      if (!r) { r = row('them', '<div class="bubble"></div>'); add(r, 'them'); }
      r.querySelector('.bubble').textContent = e.text; r.hidden = false; bubbles.delete(e.id);
      r.dataset.bid = e.id;
      // Next-step suggestions belong under the turn's last words.
      const sug = [...log.querySelectorAll('.ask-card.suggest:not(.closed)')].at(-1)?.closest('.row');
      if (sug && sug.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) log.insertBefore(sug, r.nextSibling);
      scroll();
      break;
    }
    case 'bubble_drop': bubbles.get(e.id)?.remove(); bubbles.delete(e.id); break;
    // Messages taken back after the fact (an empty wrap-up replaced by a proper introduction).
    case 'retract': for (const id of e.ids || []) log.querySelector(`.row[data-bid="${CSS.escape(id)}"]`)?.remove(); break;
    case 'typing': if (live) setTyping(e.on); break;
    case 'stage': {
      ensureCard(e.stage); setStep(e.stage); hintKind = e.stage; activity = e.text; setNow(e.text);
      if (live && typingEl) setTyping(true);
      break;
    }
    case 'activity': activity = e.text; if (card) setNow(`${e.text}…`); if (live && typingEl) setTyping(true); break;
    case 'skill_ref': {
      if (!refs.has(e.skill)) refs.set(e.skill, new Set());
      if (e.item) refs.get(e.skill).add(e.item);
      if (card && !card.dataset.done) renderRefs();
      break;
    }
    case 'plan': renderPlan(e); break;
    case 'script': {
      if (card && !card.dataset.done) card.querySelector('.head b').textContent = e.title;
      add(row('them', scriptHtml(e)), 'them'); scroll();
      break;
    }
    case 'ask': add(row('them', askHtml(e)), 'them'); scroll(); break;
    case 'images': add(row('them', imagesHtml(e)), 'them'); scroll(); break;
    case 'shot_ready': add(row('them', shotReadyHtml(e)), 'them'); if (card?.dataset.done && card.dataset.bg) setBackground(e); scroll(); break;
    case 'away': add(row('them', awayHtml(e)), 'them'); scroll(); break;
    case 'media_batch': renderBatch(e); if (live) paintBatches(); break;
    case 'file': add(row('them', `<a class="bg-item file-item" href="${esc(e.url)}" download="${esc(e.name)}">${icon('download', 16)}<span class="bg-text"><b>${esc(e.label || e.name)}</b><small>${esc(e.name)}</small></span></a>`), 'them'); scroll(); break;
    case 'shot': if (planState) renderPlan({ ...planState, shots: planState.shots.map((x) => (x.id === e.shot.id ? e.shot : x)) }); break;
    case 'shot_status': hintKind = 'seedance'; setNow(`写实镜头 ${e.id}：${{ queued: '排队中', running: '生成中', succeeded: '已完成' }[e.status] || '生成中'}`); break;
    case 'note': hintKind = 'seedance'; setNow(`${e.text}…`); break;
    case 'approval': renderApproval(e, live); break;
    case 'approval_result': {
      const box = log.querySelector(`.approval[data-aid="${CSS.escape(e.id)}"]`);
      if (box) closeApproval(box, e.ok, e.reason);
      break;
    }
    case 'video': {
      if (card) { card.dataset.version = e.version; setNow(`第 ${e.version} 版已生成，正在检查成片`); }
      addVideo(e);
      scroll(true);
      break;
    }
    case 'feedback': {
      feedback.set(e.version, { rating: e.rating, comment: e.comment });
      const box = [...log.querySelectorAll('.videobox:not(.folded)')].find((b) => Number(b.dataset.v) === e.version);
      if (box) renderFeedback(box, e.version);
      break;
    }
    case 'toast': if (live) { toast(e.text); refreshConfig(); } break;
    case 'budget': refreshConfig(); break;
    case 'system': add(Object.assign(document.createElement('div'), { className: 'sys', textContent: e.text })); break;
    case 'turn_end': {
      inTurn = false;
      finishCard(e.stopped ? 'stopped' : card?.dataset.version ? 'video' : e.ok === false ? 'error' : e.background ? 'background' : 'partial', e.ts);
      if (card && e.background && !e.stopped) card.dataset.bg = String(e.background);
      refs = new Map();
      if (live) { setTyping(false); refreshConfig(); refreshList(); }
      break;
    }
  }
  if (live && e.ts && current && !document.hidden) markSeen(current.id, e.ts);
}

/** Once a second: elapsed time on the running card, the "still thinking" hint and approval countdowns. */
setInterval(() => {
  tickApprovals();
  const idle = busy && Date.now() - lastEventAt > 20000;
  if (card && !card.dataset.done && busy) {
    card.querySelector('.elapsed').textContent = `已用 ${fmtDur(Date.now() - Number(card.dataset.start))}`;
    card.querySelector('.status .idlehint').textContent = idle ? HINTS[hintKind] || HINTS.understand : '';
  }
  const think = typingEl?.querySelector('.think');
  if (think) think.textContent = idle && !(card && !card.dataset.done) ? HINTS.understand : '';
}, 1000);

function hello() {
  log.innerHTML = '<div class="hello"><h2>你想要生成什么视频？</h2></div>';
  lastRole = null;
}

function showHeader() {
  const b = bot(current?.botId);
  $('#pTitle').textContent = b.title; $('#pDesc').textContent = b.description;
  $('#pConv').textContent = current?.versions ? `${current.title} · 已生成 ${current.versions} 版` : '暂无成片';
  presence();
}
function renderBotChip() {
  const b = bots[0];
  $('#botChip').innerHTML = `${wordmark('wm-md')}<span class="sub">${esc(b.title)}</span>`;
}
function openProfile(open) {
  if (open && traj.classList.contains('open')) openTraj(false);
  $('#profile').classList.toggle('open', open);
  $('#scrim').classList.toggle('open', open || traj.classList.contains('open'));
}

async function open(id, push = true) {
  const info = await fetch(`/api/sessions/${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!info) return;
  current = info;
  renderChips(); // this conversation's uploads only
  if (push && location.hash !== `#/c/${id}`) history.pushState(null, '', `#/c/${id}`);
  app.classList.add('chat');
  openProfile(false);
  if (traj.classList.contains('open')) { trajSig = ''; loadTraj(); }
  renderModelSelect();
  showHeader();
  renderList();
  es?.close();
  es = new EventSource(`/api/sessions/${id}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === 'replay') {
      if (PAGE_VERSION && e.pageVersion && e.pageVersion !== PAGE_VERSION) pageOutdated();
      log.innerHTML = ''; bubbles.clear(); card = null; lastCard = null; inTurn = false; typingEl = null; lastRole = null; planState = null; refs = new Map();
      videos = []; turnStart = 0; hintKind = 'understand'; busy = false; feedback = new Map(); openAsks = [];
      pendingApprovals = new Set(e.pendingApprovals || []);
      for (const h of e.events) handle(h, false);
      if (!e.events.length) hello();
      if (!e.busy) finishCard('lost', e.events.at(-1)?.ts);
      setTyping(e.busy);
      markSeen(id, e.events.at(-1)?.ts || Date.now());
      updateTitle();
      scroll(true);
    } else handle(e);
  };
  if (window.innerWidth > 760) input.focus();
}

async function newConversation(botId = bots[0].id) {
  const r = await fetch('/api/sessions', { method: 'POST', body: JSON.stringify({ botId }) });
  await open((await r.json()).id);
}

/* ---------- composer ---------- */
/** Sends a message that is not typed in the box, e.g. a tapped option on a question card. */
async function postMessage(text, extra = {}) {
  if (!current) return false;
  try {
    const r = await fetch(`/api/sessions/${current.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images: [], ...extra }) });
    if (!r.ok) throw new Error();
    setTimeout(refreshList, 500);
    return true;
  } catch {
    toast('消息发送失败，请检查网络后重试');
    return false;
  }
}
async function send() {
  const text = input.value.trim();
  if (!current || (!text && !pendingImages.length && !myUploads().length)) return;
  sendBtn.disabled = true;
  const images = pendingImages, skill = chosenSkill, files = myUploads();
  pendingImages = []; uploads = uploads.filter((f) => !files.includes(f)); chosenSkill = null; renderChips();
  input.value = ''; autosize();
  try {
    // Files still uploading are waited for, so the message can name them.
    if (files.some((f) => !f.done)) toast('等文件传完就发送');
    const done = await Promise.all(files.map((f) => f.promise.catch(() => null)));
    const media = done.filter(Boolean);
    if (!text && !images.length && !media.length) return;
    const r = await fetch(`/api/sessions/${current.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, images, skill, media }) });
    if (!r.ok) throw new Error(await r.text());
    setTimeout(refreshList, 500);
  } catch {
    handle({ type: 'system', text: '消息发送失败，请检查网络后重试' });
    input.value = text; chosenSkill = skill; renderChips(); autosize();
  } finally { input.focus(); }
}
function renderChips() {
  const skill = chosenSkill ? `<span class="chip">${icon('spark', 13)}${esc(chosenSkill)}<button data-unskill aria-label="移除技能">${icon('close', 12)}</button></span>` : '';
  $('#chips').innerHTML = skill + pendingImages.map((p, i) => `<div class="img"><img src="data:${p.mime};base64,${p.data}" alt=""><button data-i="${i}" aria-label="移除">×</button></div>`).join('')
    + myUploads().map((f, i) => `<span class="chip file${f.failed ? ' bad' : ''}" title="${esc(f.name)}">${icon(f.icon, 13)}<span class="fname">${esc(f.name.split('/').pop())}</span><small>${f.failed ? '失败' : f.done ? '已上传' : `${f.pct}%`}</small><button data-m="${i}" aria-label="移除">${icon('close', 12)}</button></span>`).join('');
  $('#skillBtn').classList.toggle('on', Boolean(chosenSkill));
  updateSend();
}
/** While a turn runs and the box is empty the send button is a stop button; typing turns it back into send (queued). */
function updateSend() {
  const has = Boolean(input.value.trim() || pendingImages.length || myUploads().length);
  const stopMode = busy && !has;
  if (sendBtn.classList.contains('stopmode') !== stopMode || !sendBtn.innerHTML) {
    sendBtn.classList.toggle('stopmode', stopMode);
    sendBtn.innerHTML = icon(stopMode ? 'stop' : 'send', 18);
    sendBtn.setAttribute('aria-label', stopMode ? '停止' : '发送');
    sendBtn.title = stopMode ? '停止' : '发送';
  }
  sendBtn.disabled = stopMode ? stopping : !has;
}
async function stop() {
  if (!current || stopping) return;
  stopping = true; updateSend(); presence('正在停止', true);
  try { await fetch(`/api/sessions/${current.id}/interrupt`, { method: 'POST' }); } catch { stopping = false; updateSend(); }
}
$('#chips').onclick = (e) => {
  if (e.target.closest('[data-unskill]')) { chosenSkill = null; return renderChips(); }
  const i = e.target.closest('[data-i]')?.dataset.i;
  if (i !== undefined) { pendingImages.splice(+i, 1); renderChips(); }
  const m = e.target.closest('[data-m]')?.dataset.m;
  if (m !== undefined) { const f = myUploads()[+m]; if (f) { uploads = uploads.filter((x) => x !== f); f.cancel(); } renderChips(); }
};
$('#attach').onclick = () => $('#file').click();
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
async function addFiles(files, names = []) {
  const list = [...files];
  // A few small pictures picked on their own go inline with the message (the model sees them at once);
  // pictures picked together with other files, or more than 6, are uploaded as material like the rest.
  const pics = list.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= 8 * 1024 * 1024);
  const images = pics.length === list.length && pendingImages.length + pics.length <= 6 ? pics : [];
  const material = list.filter((f) => !images.includes(f));
  if (material.length) uploadBatch(material, material.map((f) => names[list.indexOf(f)] || f.webkitRelativePath || f.name));
  for (const f of images) {
    if (pendingImages.length >= 6) { toast('每条消息最多添加 6 张图片'); break; }
    if (f.size > 8 * 1024 * 1024) { toast(`${f.name || '图片'} 超过 8 MB，请选择较小的图片`); continue; }
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(f); });
    pendingImages.push({ name: f.name || 'image', mime: f.type, data });
  }
  renderChips();
}
$('#file').onchange = async (e) => { await addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); addFiles(files); }
});
const main = $('#main');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
main.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !current) return; e.preventDefault(); dragDepth++; main.classList.add('dropping'); });
main.addEventListener('dragover', (e) => { if (!hasFiles(e) || !current) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
main.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; main.classList.remove('dropping'); } });
main.addEventListener('drop', (e) => {
  if (!hasFiles(e) || !current) return;
  e.preventDefault(); dragDepth = 0; main.classList.remove('dropping');
  // A dropped folder is walked; its path is kept only as the file's display name.
  const entries = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.some((x) => x.isDirectory)) {
    walkEntries(entries).then(({ files, names }) => addFiles(files, names));
  } else addFiles(e.dataTransfer.files);
  input.focus();
});
async function walkEntries(entries, prefix = '', out = { files: [], names: [] }) {
  for (const en of entries) {
    if (out.files.length >= 60) break;
    if (en.isFile) {
      const f = await new Promise((res, rej) => en.file(res, rej)).catch(() => null);
      if (f && !en.name.startsWith('.')) { out.files.push(f); out.names.push(prefix + en.name); }
    } else if (en.isDirectory) {
      const reader = en.createReader();
      const kids = [];
      for (let batch; (batch = await new Promise((res) => reader.readEntries(res, () => res([])))).length;) kids.push(...batch);
      await walkEntries(kids, `${prefix}${en.name}/`, out);
    }
  }
  return out;
}

/* ---------- uploads (videos, audio, documents) ---------- */
/**
 * Files being uploaded, each bound to the conversation it was picked in: switching conversations shows that
 * conversation's files, and a message only ever carries its own conversation's media.
 */
let uploads = [];
const myUploads = () => uploads.filter((f) => f.sid === current?.id);
let uploadSlots = 0;
const uploadQueue = [];
const localProgress = new Map(); // uploadId -> percent, merged into the progress card
function nextUpload() {
  while (uploadSlots < 2 && uploadQueue.length) { uploadSlots++; uploadQueue.shift()().finally(() => { uploadSlots--; nextUpload(); }); }
}
function uploadBatch(files, names) {
  if (!current) return;
  const sid = current.id, batch = `b${Date.now().toString(36)}`;
  for (const [k, f] of files.entries()) {
    const entry = { name: names[k] || f.name, pct: 0, done: false, failed: false, aborted: false, uploadId: null, icon: f.type.startsWith('video') ? 'film' : f.type.startsWith('audio') ? 'music' : f.type.startsWith('image') ? 'image' : 'file' };
    entry.cancel = () => { entry.aborted = true; if (entry.uploadId) fetch(`/api/sessions/${sid}/uploads/${entry.uploadId}`, { method: 'DELETE' }); };
    // A failure before completion cancels the upload on the server too, so its row in the progress card settles.
    entry.promise = new Promise((resolve, reject) => uploadQueue.push(() => uploadOne(sid, batch, f, entry).then(resolve, (err) => { if (!entry.completing) entry.cancel(); entry.failed = true; renderChips(); toast(`${entry.name.split('/').pop()}：${err.message}`); reject(err); })));
    entry.promise.catch(() => {});
    entry.sid = sid;
    uploads.push(entry);
  }
  renderChips();
  nextUpload();
}
async function uploadOne(sid, batch, file, entry) {
  if (entry.aborted) throw new Error('已取消');
  const begin = await fetch(`/api/sessions/${sid}/uploads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: entry.name, size: file.size, batch }) });
  const b = await begin.json().catch(() => ({}));
  if (!begin.ok) throw new Error(b.error || '上传被拒绝');
  entry.uploadId = b.id;
  for (let off = 0; off < file.size;) {
    if (entry.aborted) throw new Error('已取消');
    const part = file.slice(off, off + b.chunkBytes);
    let ok = false, err = '';
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const r = await fetch(`/api/sessions/${sid}/uploads/${b.id}?offset=${off}`, { method: 'PUT', body: part }).catch(() => null);
      if (r?.ok) { ok = true; off += part.size; } else { err = (await r?.json().catch(() => ({})))?.error || '网络错误'; await new Promise((res) => setTimeout(res, 1000 * (attempt + 1))); }
    }
    if (!ok) throw new Error(err);
    entry.pct = Math.floor((off / file.size) * 100);
    localProgress.set(b.id, entry.pct);
    renderChips(); paintBatches();
  }
  entry.completing = true;
  const done = await fetch(`/api/sessions/${sid}/uploads/${b.id}/complete`, { method: 'POST' });
  const d = await done.json().catch(() => ({}));
  if (!done.ok || d.status !== 'complete') throw new Error(d.error || '文件没有通过检查');
  entry.done = true; entry.pct = 100; localProgress.delete(b.id);
  renderChips();
  return d.mediaId;
}

/* ---------- material progress card ---------- */
const MEDIA_STATUS = { uploading: '上传中', processing: '处理中', ready: '已入库', rejected: '未通过检查', failed: '处理失败', cancelled: '已取消' };
const fmtSize = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.max(0.1, n / (1 << 20)).toFixed(1)} MB`);
function batchHtml(e) {
  const rows = e.items.map((it) => {
    const state = it.status === 'processing' && it.stage ? it.stage : MEDIA_STATUS[it.status] || it.status;
    const cls = it.status === 'ready' ? 'ok' : it.status === 'rejected' || it.status === 'failed' ? 'bad' : '';
    return `<li class="${cls}"><span class="fname" title="${esc(it.name)}">${esc(it.name)}</span><small>${fmtSize(it.size)}</small><span class="st" data-st="${esc(it.status)}">${esc(state)}</span>${it.error ? `<span class="err">${esc(it.error)}</span>` : ''}</li>`;
  }).join('');
  const done = e.items.filter((x) => ['ready', 'rejected', 'failed', 'cancelled'].includes(x.status)).length;
  return `<div class="media-batch" data-batch="${esc(e.batch)}"><div class="mb-head">${icon('upload', 15)}<b>素材</b><span>${done}/${e.items.length}</span></div><ul>${rows}</ul></div>`;
}
function renderBatch(e) {
  const old = log.querySelector(`.media-batch[data-batch="${CSS.escape(e.batch)}"]`)?.closest('.row');
  const r = row('them', batchHtml(e));
  if (old) old.replaceWith(r); else add(r, 'them');
  scroll();
}
/** Live byte progress from this browser on rows the server still reports as uploading. */
function paintBatches() {
  for (const it of myUploads()) {
    if (!it.uploadId || it.done) continue;
    for (const st of log.querySelectorAll('.media-batch li .st[data-st="uploading"]')) {
      if (st.closest('li').querySelector('.fname').textContent === it.name) st.textContent = `上传中 ${it.pct}%`;
    }
  }
}
const menu = $('#skillMenu');
$('#skillBtn').onclick = (e) => {
  e.stopPropagation();
  menu.innerHTML = enabledSkills.length
    ? enabledSkills.map((s) => `<button class="item" data-skill="${esc(s.name)}"><b>${icon('spark', 14)}${esc(s.name)}</b><span>${esc(s.description)}</span></button>`).join('')
    : '<div class="empty">未启用技能</div>';
  menu.hidden = !menu.hidden;
};
menu.onclick = (e) => {
  const it = e.target.closest('[data-skill]');
  if (!it) return;
  chosenSkill = it.dataset.skill; menu.hidden = true; renderChips(); input.focus();
};
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; updateSend(); }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
sendBtn.onclick = () => (sendBtn.classList.contains('stopmode') ? stop() : send());

/* ---------- system panel ---------- */
let sys = null, tab = 'usage';
async function openSystem(which = 'usage') {
  tab = which;
  $('#sysBack').hidden = false;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  $('#pane').innerHTML = '<p class="note">加载中…</p>';
  try { sys = await (await fetch('/api/system')).json(); } catch { $('#pane').innerHTML = '<p class="note">加载失败，请稍后重试</p>'; return; }
  renderPane();
}
function closeSystem() { $('#sysBack').hidden = true; }
$('#tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderPane();
};
$('#sysClose').onclick = closeSystem; $('#sysClose2').onclick = closeSystem;
$('#sysBack').onclick = (e) => { if (e.target === $('#sysBack')) closeSystem(); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closePreview(); closeSystem(); openProfile(false); closeConvMenu(); menu.hidden = true;
  if (traj.classList.contains('open')) openTraj(false);
});

function renderPane() {
  const p = $('#pane');
  if (tab === 'usage') {
    const b = sys.budget, u = sys.usage;
    const pct = Math.min(100, b.ratio * 100);
    p.innerHTML = `<div class="big"><b>已用 ${money(b.spent)}</b><span>/ 上限 $${b.limit}</span></div>
      <div class="bar-row"><div class="meter ${b.level === 'red' ? 'red' : b.ratio >= 0.8 ? 'yellow' : ''}"><i style="width:${pct}%"></i></div><span>${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%</span></div>
      <div class="cards2">
        <div class="mini"><span>对话（Claude）</span><b>${money(u.claudeUsd)}</b><small>${u.claudeCounted ? '估算' : '本机开发账号，不计费'}</small></div>
        <div class="mini"><span>写实镜头（Seedance）</span><b>${money(u.seedanceUsd)}</b><small>${u.seedanceEstimated ? `按服务商实际扣费，含 ${u.seedanceEstimated} 笔估算` : '按服务商实际扣费'}</small></div>
      </div>
      <h4>按对话</h4>
      ${u.conversations.length ? u.conversations.map((c) => `<div class="conv-cost" data-open="${c.id}">
        <div class="thumb40" style="${c.thumb ? `background-image:url('${c.thumb}')` : ''}">${c.thumb ? '' : icon('film', 20)}</div>
        <div class="t"><b>${esc(c.title)}</b><span>${c.shots} 个写实镜头</span></div><span class="amt">${money(c.usd)}</span></div>`).join('') : '<p class="note">暂无费用</p>'}
      <details class="ledger"><summary>明细（最近 ${u.entries.length} 笔）</summary>
        <table class="tbl"><thead><tr><th>时间</th><th>对话</th><th>项目</th><th>模型</th><th style="text-align:right">金额</th><th></th></tr></thead><tbody>
        ${u.entries.map((e) => `<tr><td>${fmtDateTime(e.ts)}</td><td class="ell">${esc(e.title)}</td><td class="ell">${esc(e.item)}</td><td>${esc(e.model)}</td><td class="num">${money(e.usd)}</td><td><span class="tag ${e.basis}">${e.basis === 'actual' ? '实际' : '估算'}</span></td></tr>`).join('')}
        </tbody></table></details>
      <p class="note">写实镜头按服务商返回的实际扣费记账，人民币按 1 美元 = ${u.rate} 元换算；无法获取实际扣费时按单价表估算，并标注为“估算”。对话及点评费用按 Claude SDK 提供的估算值记账，使用本机开发账号时不计入。达到上限后将停止调用付费服务。</p>`;
  } else if (tab === 'skills') {
    p.innerHTML = `<p class="note" style="margin-top:0">技能由管理员在服务器上安装（npm run skill:add &lt;仓库地址&gt;），可在此启用或停用。启用后，可通过输入框旁的 ✦ 指定使用的技能。</p>
      ${sys.skills.length ? sys.skills.map((s) => `<div class="skill-card" data-skill="${esc(s.name)}">
        <div class="top"><div class="t"><b>${esc(s.name)}</b><p>${esc(s.description)}</p>
        <div class="src">${s.source ? `来源 <a href="${esc(s.source)}" target="_blank" rel="noopener">${esc(s.source.replace(/^https:\/\//, ''))}</a>${s.commit ? ` @ ${esc(s.commit.slice(0, 7))}` : ''}` : '本地安装'}</div></div>
        <label class="switch"><input type="checkbox" ${s.enabled ? 'checked' : ''} data-toggle="${esc(s.name)}"><i></i></label></div>
        <button class="more" data-readme="${esc(s.name)}">查看说明</button><div class="md" hidden></div></div>`).join('') : '<p class="note">未安装技能</p>'}`;
  } else if (tab === 'status') {
    const s = sys.status;
    const cl = s.claude;
    const clState = cl.errorAt && (!cl.okAt || cl.errorAt > cl.okAt) ? ['bad-dot', '最近一次调用出错'] : cl.okAt ? ['ok-dot', '已连接'] : ['idle-dot', '尚未调用'];
    const ep = { configured: '自定义端点', 'api-key': 'API key', 'local-login': '本机 Claude Code 登录' }[cl.endpoint];
    const sd = s.seedance;
    p.innerHTML = `<div class="svc"><div class="h"><i class="${clState[0]}"></i>对话模型（Claude）</div>
        <dl class="kv"><dt>状态</dt><dd>${clState[1]}${cl.okAt ? `，最近成功 ${fmtDateTime(cl.okAt)}` : ''}</dd><dt>模型</dt><dd>${esc(cl.model)}</dd><dt>接入方式</dt><dd>${ep}</dd>${cl.error && clState[0] === 'bad-dot' ? `<dt>错误</dt><dd>${esc(cl.error)}</dd>` : ''}</dl></div>
      <div class="svc"><div class="h"><i class="${sd.mock ? 'warn-dot' : 'ok-dot'}"></i>写实镜头（Seedance）</div>
        <dl class="kv"><dt>状态</dt><dd>${sd.mock ? '示意画面模式（未接入生成服务）' : '已接通'}</dd><dt>模型</dt><dd>${esc(sd.model)}</dd><dt>清晰度</dt><dd>${sd.resolution}</dd><dt>生成中</dt><dd>${sd.pending} 个</dd></dl></div>
      <div class="svc"><div class="h"><i class="ok-dot"></i>渲染</div>
        <dl class="kv"><dt>进行中</dt><dd>${s.render.active} / ${s.render.max}${s.render.queued ? `，排队 ${s.render.queued}` : ''}</dd>
        ${s.disk ? `<dt>磁盘</dt><dd>已用 ${s.disk.usedGb.toFixed(1)} GB / ${s.disk.totalGb.toFixed(0)} GB</dd>` : ''}</dl></div>`;
  } else if (tab === 'models') {
    renderModels(p);
  } else if (tab === 'reviews') {
    renderReviews(p);
  } else if (tab === 'memory') {
    renderMemory(p);
  } else if (tab === 'trash') {
    p.innerHTML = '<p class="note" style="margin-top:0">加载中…</p>';
    fetch('/api/trash').then((r) => r.json()).then(({ items, days }) => {
      if (tab !== 'trash') return;
      p.innerHTML = `<p class="note" style="margin-top:0">已删除的对话保留 ${days} 天，到期后自动清除。当前未启用登录，所有访问者共用同一个回收站。</p>
        ${items.length ? items.map((t) => {
          const left = Math.max(0, Math.ceil(days - (Date.now() - t.deletedAt) / 86400000));
          return `<div class="trash-row" data-trash="${t.id}"><div class="t"><b>${esc(t.title)}</b><span>${fmtDateTime(t.deletedAt)} 删除 · ${t.pending ? '正在停止生成，完成后移入回收站' : `${left} 天后自动清除`}</span></div>
            <button class="btn" data-restore="${t.id}">恢复</button>${t.pending ? '' : `<button class="btn danger-text" data-purge="${t.id}" data-title="${esc(t.title)}">彻底删除</button>`}</div>`;
        }).join('') : '<p class="note">回收站为空</p>'}`;
    }).catch(() => { p.innerHTML = '<p class="note">加载失败，请稍后重试</p>'; });
  } else {
    const a = sys.about;
    p.innerHTML = `<dl class="kv"><dt>版本</dt><dd>${esc(a.commit || '未知')}</dd><dt>部署时间</dt><dd>${a.deployedAt ? fmtDateTime(a.deployedAt) : '未知'}</dd><dt>本次启动</dt><dd>${fmtDateTime(a.startedAt)}</dd></dl>`;
  }
}
/* ---------- 模型 tab ---------- */
let models = null;
async function loadModels() {
  try { models = await (await fetch('/api/models')).json(); } catch { models = null; }
  return models;
}
async function renderModels(p) {
  const m = await loadModels();
  if (tab !== 'models') return;
  if (!m) { p.innerHTML = '<p class="note">加载失败，请稍后重试</p>'; return; }
  const st = m.settings;
  const radio = (name, list, value) => list.map((x) => `<label class="choice"><input type="radio" name="${name}" value="${esc(x.id)}" ${x.id === value ? 'checked' : ''} data-setting-value="${name}"><span><b>${esc(x.label)}</b><small>${esc(x.note)}</small></span></label>`).join('');
  const voiceSel = (name, keys) => `<select data-setting-value="${name}">${keys.map((k) => `<option value="${k}" ${st[name] === k ? 'selected' : ''}>${esc(m.voices[k])}</option>`).join('')}</select>`;
  p.innerHTML = `
    <h4 style="margin-top:0">对话模型</h4><p class="note tight">默认用于所有对话；单个对话可在顶栏单独切换，下一轮生效。</p>
    <div class="choices">${radio('chatModel', m.chat, st.chatModel)}</div>
    <h4>思考强度</h4><p class="note tight">强度越高，规划和动画质量越好，但首句之后的制作更慢、费用更高。</p>
    <div class="seg-ctl">${[['low', '低'], ['medium', '中'], ['high', '高']].map(([v, l]) => `<label><input type="radio" name="effort" value="${v}" ${st.effort === v ? 'checked' : ''} data-setting-value="effort"><span>${l}</span></label>`).join('')}</div>
    <h4>写实镜头模型</h4><p class="note tight">清晰度固定为 480p。</p>
    <div class="choices">${radio('seedanceModel', m.seedance, st.seedanceModel)}</div>
    <h4>配音</h4>
    <div class="setting"><div><b>剧本口播自动配音</b><p>按段合成口播并混入成片，背景音乐在口播处自动压低；每段约增加数秒处理时间，按字数计费。</p></div>
      <label class="switch"><input type="checkbox" data-setting="voiceover" ${st.voiceover ? 'checked' : ''}><i></i></label></div>
    <div class="voice-row"><span>中文音色</span>${voiceSel('voiceZh', Object.keys(m.voices).filter((k) => k.startsWith('zh_')))}<span>英文音色</span>${voiceSel('voiceEn', Object.keys(m.voices).filter((k) => k.startsWith('en_')))}</div>
    <h4>同步声音</h4>
    <div class="setting"><div><b>写实镜头默认带同步声音</b><p>人物出镜说话、需要环境声的镜头会生成原声并保留在成片中；开启后写实镜头费用可能上升。模型也可按镜头自行开启。</p></div>
      <label class="switch"><input type="checkbox" data-setting="syncAudio" ${st.syncAudio ? 'checked' : ''}><i></i></label></div>
    ${m.relay ? '' : '<p class="note warn-note">当前环境未配置中转服务：配音使用示意音轨，查资料不可用。</p>'}`;
}
$('#pane').addEventListener('change', async (e) => {
  const v = e.target.closest('[data-setting-value]');
  if (!v) return;
  const r = await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ [v.dataset.settingValue]: v.value }) }).catch(() => null);
  if (!r?.ok) toast('保存失败');
  if (v.dataset.settingValue === 'chatModel') renderModelSelect();
});

/** Top bar: this conversation's model; "默认" follows the system setting. */
async function renderModelSelect() {
  const sel = $('#modelSel');
  if (!current) return;
  const m = models || (await loadModels());
  if (!m) return;
  const label = (id) => m.chat.find((x) => x.id === id)?.label || id;
  // Phones show only the version ("5.5") so the title keeps its room.
  const short = (id) => (window.innerWidth <= 760 ? label(id).replace(/^[A-Za-z]+\s*/, '') : label(id));
  sel.innerHTML = `<option value="">${window.innerWidth <= 760 ? '' : '默认 · '}${esc(short(m.settings.chatModel))}</option>` + m.chat.map((x) => `<option value="${esc(x.id)}">${esc(short(x.id))}</option>`).join('');
  sel.value = current.modelOverride || '';
}
$('#modelSel').addEventListener('change', async (e) => {
  if (!current) return;
  const r = await fetch(`/api/sessions/${current.id}/model`, { method: 'POST', body: JSON.stringify({ model: e.target.value }) }).catch(() => null);
  if (!r?.ok) { toast('切换失败，请重试'); e.target.value = current.modelOverride || ''; return; }
  current.modelOverride = (await r.json()).override;
});

/* ---------- 轨迹 tab: every reviewed turn, sortable, plus the export ---------- */
let reviewSort = { key: 'ts', dir: -1 };
const avgOf = (sc) => { const v = SCORE_NAMES.map(([k]) => sc[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
async function renderReviews(p) {
  p.innerHTML = '<p class="note" style="margin-top:0">加载中…</p>';
  let j;
  try { j = await (await fetch('/api/reviews')).json(); } catch { p.innerHTML = '<p class="note">加载失败，请稍后重试</p>'; return; }
  if (tab !== 'reviews') return;
  const rows = j.rows.map((r) => ({ ...r, avg: avgOf(r.scores) }));
  const val = (r, k) => (k === 'ts' ? Date.parse(r.turnStart || r.ts) : k === 'avg' ? r.avg : r.scores[k] ?? -1);
  rows.sort((a, b) => (val(a, reviewSort.key) - val(b, reviewSort.key)) * reviewSort.dir);
  const mean = (k) => { const v = rows.map((r) => r.scores[k]).filter((x) => x != null); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : '—'; };
  const th = (k, l) => `<button class="th ${reviewSort.key === k ? 'on' : ''}" data-sort="${k}">${l}${reviewSort.key === k ? (reviewSort.dir < 0 ? ' ↓' : ' ↑') : ''}</button>`;
  p.innerHTML = `<div class="setting"><div><b>自动点评</b><p>每轮对话结束后，系统在后台调用模型，从响应速度、对话自然度、需求遵循度、成片质量四个维度评分（1–5 分）并给出点评；费用计入用量，标注为“点评”。</p></div>
      <label class="switch"><input type="checkbox" data-setting="reviewEnabled" ${j.enabled ? 'checked' : ''}><i></i></label></div>
    <div class="rv-sum"><span>已点评 <b>${rows.length}</b> 轮</span>${SCORE_NAMES.map(([k, l]) => `<span>${l} <b>${mean(k)}</b></span>`).join('')}${j.pending ? `<span class="muted"><i class="spin"></i> ${j.pending} 条点评生成中</span>` : ''}
      <a class="btn sm export" href="/api/export" download>${icon('download', 14)}导出全部轨迹和点评</a></div>
    ${rows.length ? `<div class="rtable"><div class="rhead">${th('ts', '时间')}<span>对话</span>${SCORE_NAMES.map(([k, l]) => th(k, l)).join('')}${th('avg', '均分')}</div>
      ${rows.map((r) => `<div class="rrow ${r.deleted ? 'gone' : ''}" ${r.deleted ? '' : `data-review="${r.session}"`} title="${esc(r.comments)}">
        <span class="when">${fmtDateTime(Date.parse(r.turnStart || r.ts))}</span>
        <span class="conv-t"><b>${esc(r.title)}</b><small>第 ${r.index} 轮 · ${esc(r.comments)}</small></span>
        ${SCORE_NAMES.map(([k, l]) => `<span class="num s${r.scores[k] ?? 'n'}" data-l="${l}">${r.scores[k] ?? '—'}</span>`).join('')}
        <span class="num avg" data-l="均分">${r.avg.toFixed(1)}</span></div>`).join('')}</div>`
    : '<p class="note">暂无点评。成片生成后约 1 分钟内显示首条点评。</p>'}
    <p class="note">导出文件为 .tar.gz，包含各对话的 trajectory.jsonl（每次工具调用的参数、结果与耗时）、点评、记忆及用量明细，可用于与其他 harness 对比分析。</p>`;
}

/* ---------- 记忆 tab ---------- */
let memEditing = null;
async function renderMemory(p) {
  let j;
  try { j = await (await fetch('/api/memory')).json(); } catch { p.innerHTML = '<p class="note">加载失败，请稍后重试</p>'; return; }
  if (tab !== 'memory') return;
  const byCat = j.categories.map((c) => [c, j.items.filter((m) => m.category === c).sort((a, b) => b.confidence - a.confidence)]).filter(([, l]) => l.length);
  const item = (m) => memEditing === m.id
    ? `<div class="mem editing" data-mem="${m.id}"><select>${j.categories.map((c) => `<option ${c === m.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input value="${esc(m.content)}" maxlength="200"><button class="btn sm primary" data-mem-save>保存</button><button class="btn sm" data-mem-cancel>取消</button></div>`
    : `<div class="mem" data-mem="${m.id}"><div class="c"><span>${esc(m.content)}</span>
        <small>${m.source === 'manual' ? '手动' : '自动'} · 置信度 ${Math.round(m.confidence * 100)}% · ${fmtDateTime(Date.parse(m.updatedAt))}${m.evidence.length ? ` · 依据 ${m.evidence.map((ev) => `<a ${ev.title ? `data-open="${esc(ev.session)}"` : ''} title="${esc(ev.title || '已删除的对话')}">「${esc(ev.quote)}」</a>`).join(' ')}` : ''}</small></div>
        <button class="btn sm" data-mem-edit>编辑</button><button class="btn sm danger-text" data-mem-del>删除</button></div>`;
  p.innerHTML = `<div class="setting"><div><b>自动更新</b><p>系统在每轮对话结束及收到评价后自动整理用户偏好；新对话将引用置信度最高的 ${j.promptLimit} 条，用户当轮的明确要求优先于记忆。</p></div>
      <label class="switch"><input type="checkbox" data-setting="memoryAutoUpdate" ${j.autoUpdate ? 'checked' : ''}><i></i></label></div>
    <p class="note warn-note">当前未启用登录，所有访问者共用同一份记忆，修改对所有人生效。</p>
    <form class="mem-add"><select name="category">${j.categories.map((c) => `<option>${c}</option>`).join('')}</select><input name="content" maxlength="200" placeholder="手动添加偏好，例如：结尾须包含门店地址"><button class="btn sm primary">添加</button></form>
    ${byCat.length ? byCat.map(([c, list]) => `<h4>${c}</h4>${list.map(item).join('')}`).join('') : '<p class="note">暂无记忆。系统将根据对话内容及成片评价自动整理。</p>'}`;
  p.querySelector('.editing input')?.focus();
}

$('#pane').addEventListener('submit', async (e) => {
  if (!e.target.matches('.mem-add')) return;
  e.preventDefault();
  const f = new FormData(e.target);
  if (!String(f.get('content')).trim()) return;
  const r = await fetch('/api/memory', { method: 'POST', body: JSON.stringify({ category: f.get('category'), content: f.get('content') }) }).catch(() => null);
  if (!r?.ok) toast('添加失败');
  renderPane();
});
$('#pane').addEventListener('keydown', (e) => {
  if (!e.target.closest('.mem.editing input')) return;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); e.target.closest('.mem').querySelector('[data-mem-save]').click(); }
  if (e.key === 'Escape') { e.stopPropagation(); memEditing = null; renderPane(); }
});
$('#pane').addEventListener('click', async (e) => {
  const sort = e.target.closest('[data-sort]');
  if (sort) {
    reviewSort = reviewSort.key === sort.dataset.sort ? { key: reviewSort.key, dir: -reviewSort.dir } : { key: sort.dataset.sort, dir: -1 };
    return renderPane();
  }
  const rv = e.target.closest('[data-review]');
  if (rv) { closeSystem(); await open(rv.dataset.review); return openTraj(true); }
  const mem = e.target.closest('[data-mem]');
  if (mem && e.target.closest('[data-mem-edit]')) { memEditing = mem.dataset.mem; return renderPane(); }
  if (mem && e.target.closest('[data-mem-cancel]')) { memEditing = null; return renderPane(); }
  if (mem && e.target.closest('[data-mem-save]')) {
    const r = await fetch(`/api/memory/${mem.dataset.mem}`, { method: 'POST', body: JSON.stringify({ category: mem.querySelector('select').value, content: mem.querySelector('input').value }) }).catch(() => null);
    if (!r?.ok) toast('保存失败');
    memEditing = null;
    return renderPane();
  }
  if (mem && e.target.closest('[data-mem-del]')) {
    const r = await fetch(`/api/memory/${mem.dataset.mem}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) toast('删除失败');
    return renderPane();
  }
  const rs = e.target.closest('[data-restore]');
  if (rs) {
    rs.disabled = true;
    await restoreConversation(rs.dataset.restore, false);
    return renderPane();
  }
  const pg = e.target.closest('[data-purge]');
  if (pg) {
    const ok = await confirmDialog({ title: `彻底删除「${pg.dataset.title}」？`, text: '对话、镜头及所有版本的成片将被永久删除，无法恢复。', ok: '彻底删除', danger: true });
    if (!ok) return;
    const r = await fetch(`/api/trash/${pg.dataset.purge}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) toast('删除失败，请稍后重试');
    return renderPane();
  }
  const o = e.target.closest('[data-open]');
  if (o) { closeSystem(); return open(o.dataset.open); }
  const r = e.target.closest('[data-readme]');
  if (r) {
    const box = r.nextElementSibling;
    if (box.hidden && !box.innerHTML) {
      const j = await (await fetch(`/api/skills/${encodeURIComponent(r.dataset.readme)}/readme`)).json();
      box.innerHTML = markdown(j.text || '');
    }
    box.hidden = !box.hidden;
    r.textContent = box.hidden ? '查看说明' : '收起说明';
  }
});
$('#pane').addEventListener('change', async (e) => {
  const st = e.target.closest('[data-setting]');
  if (st) {
    const r = await fetch('/api/settings', { method: 'POST', body: JSON.stringify({ [st.dataset.setting]: st.checked }) }).catch(() => null);
    if (!r?.ok) { st.checked = !st.checked; toast('保存失败'); }
    return;
  }
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  await fetch(`/api/skills/${encodeURIComponent(t.dataset.toggle)}`, { method: 'POST', body: JSON.stringify({ enabled: t.checked }) });
  refreshConfig();
});

/** Minimal Markdown → HTML for SKILL.md (headings, fences, lists, inline code, bold, links); input is escaped first. */
function markdown(src) {
  const body = src.replace(/^---[\s\S]*?\n---\s*\n/, '');
  const out = [];
  let inCode = false, list = false;
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) { if (list) { out.push('</ul>'); list = false; } out.push(inCode ? '</code></pre>' : '<pre><code>'); inCode = !inCode; continue; }
    if (inCode) { out.push(esc(line) + '\n'); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h${Math.min(4, h[1].length + 1)}>${inline(h[2])}</h${Math.min(4, h[1].length + 1)}>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  if (inCode) out.push('</code></pre>');
  return out.join('');
}

/* ---------- navigation ---------- */
$('#newBtn').onclick = () => newConversation();
$('#botChip').onclick = () => { if (current) openProfile(true); else newConversation(); };
$('#skillsEntry').onclick = () => openSystem('skills');
$('#systemEntry').onclick = () => openSystem('usage');
$('#infoBtn').onclick = () => openProfile(true);
$('#who').onclick = () => openProfile(true);
$('#closeProfile').onclick = () => openProfile(false);
$('#scrim').onclick = () => { openProfile(false); openTraj(false); };
function toList() { app.classList.remove('chat'); es?.close(); openTraj(false); current = null; refreshList(); }
$('#back').onclick = () => { history.pushState(null, '', '#/'); toList(); };
window.addEventListener('popstate', () => {
  const m = location.hash.match(/^#\/c\/([a-f0-9-]{36})$/);
  if (m) open(m[1], false); else toList();
});

(async function start() {
  bots = (await (await fetch('/api/bots')).json()).bots;
  renderBotChip();
  refreshConfig();
  await refreshList();
  setInterval(refreshList, 5000);
  setInterval(refreshConfig, 30000);
  const m = location.hash.match(/^#\/c\/([a-f0-9-]{36})$/);
  if (m) open(m[1], false);
  else if (window.innerWidth > 760) {
    if (sessions[0]) open(sessions[0].id);
    else newConversation();
  }
})();
