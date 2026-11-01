// Drives the running demo over HTTP like a browser: sends messages one by one and prints what the
// user would see (bubbles, plan card, video) with timings. Usage: node scripts/tools/chat-e2e.mjs "msg1" "msg2" ...
const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const messages = process.argv.slice(2);
const { id } = await (await fetch(`${BASE}/api/sessions`, { method: 'POST', body: '{"botId":"video"}' })).json();
console.log('session', id);

const res = await fetch(`${BASE}/api/sessions/${id}/events`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let turnDone = null;
let t0 = Date.now();
let firstText = null;

(async () => {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith('data: ')) continue;
      const e = JSON.parse(chunk.slice(6));
      const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
      // The opening line may arrive whole (written by the opener call) rather than as streamed deltas.
      if ((e.type === 'delta' || e.type === 'bubble_end') && firstText === null) firstText = Date.now() - t0;
      if (e.type === 'bubble_end') console.log(`${t}s  Bot: ${e.text}`);
      else if (e.type === 'plan' && e.shots.every((s) => s.status !== 'working')) console.log(`${t}s  [分镜卡] ${e.title} · ${e.aspect} · ${e.seconds}s · ${e.shots.map((s) => `${s.id}:${s.kind}/${s.status}`).join(' ')}`);
      else if (e.type === 'shot') console.log(`${t}s  [镜头] ${e.shot.id} ${e.shot.status}${e.shot.error ? ' ' + e.shot.error : ''}`);
      else if (e.type === 'activity' || e.type === 'stage') console.log(`${t}s  [状态] ${e.stage ? e.stage + ' · ' : ''}${e.text}`);
      else if (e.type === 'turn_start') console.log(`${t}s  [回合开始]`);
      else if (e.type === 'skill_ref') console.log(`${t}s  [技能] ${e.skill}${e.item ? ' · ' + e.item : ''}`);
      else if (e.type === 'toast') console.log(`${t}s  [toast] ${e.text}`);
      else if (e.type === 'script') console.log(`${t}s  [剧本卡 v${e.version}] ${e.title} · ${e.total_seconds}s ${e.aspect} ${e.vo_language} · insight: ${e.insight}\n${e.segments.map((g) => `           ${e.changed?.includes(g.id) ? '*' : ' '} ${g.start}-${g.end}s ${g.role} | ${g.visual.slice(0, 50)} | VO: ${g.vo ?? '-'}`).join('\n')}${e.sources?.length ? `\n           sources: ${e.sources.map((x) => x.title).join(' ; ')}` : ''}`);
      else if (e.type === 'ask') console.log(`${t}s  [问题卡${e.mode === 'suggest' ? '·建议' : ''}] ${e.question} :: ${e.options.map((o, i) => `${String.fromCharCode(65 + i)}${e.recommended === i ? '*' : ''} ${o}`).join(' / ')}`);
      else if (e.type === 'research') console.log(`${t}s  [查资料] ${e.query} (${e.sources?.length ?? 0} sources)`);
      else if (e.type === 'video') console.log(`${t}s  [视频] 第${e.version}版 ${e.seconds}s ${BASE}${e.url}`);
      else if (e.type === 'system') console.log(`${t}s  [系统] ${e.text}`);
      else if (e.type === 'approval') {
        const ok = process.env.APPROVE !== 'no';
        console.log(`${t}s  [审批卡] ${e.title} — ${e.detail}  → 点「${ok ? '允许一次' : '拒绝'}」`);
        fetch(`${BASE}/api/sessions/${id}/approvals/${e.id}`, { method: 'POST', body: JSON.stringify({ ok }) });
      } else if (e.type === 'approval_result') console.log(`${t}s  [审批结果] ${e.ok ? '允许' : '拒绝'}`);
      else if (e.type === 'turn_end') { console.log(`${t}s  [回合结束] ok=${e.ok} 累计成本 $${e.costUsd?.toFixed(3)} 首字 ${firstText}ms`); turnDone?.(); }
    }
  }
})();

for (const m of messages) {
  t0 = Date.now();
  firstText = null;
  console.log(`\n>>> 用户: ${m}`);
  const done = new Promise((r) => (turnDone = r));
  // SKILL=<name> attaches that skill to the first message, like picking it from the composer.
  const skill = messages.indexOf(m) === 0 ? process.env.SKILL : undefined;
  await fetch(`${BASE}/api/sessions/${id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: m, skill }) });
  await Promise.race([done, new Promise((r) => setTimeout(r, 15 * 60_000))]);
}
console.log('\nworkspace: data/sessions/' + id);
process.exit(0);
