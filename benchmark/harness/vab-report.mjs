// Builds the Chinese report for one task (VAB_TASK, default vab-t1; report-vab-task1.md for Task 1, report-<task>.md
// otherwise): side-by-side table of our two runs (v1/v2) and the external system on the task's rubric, automatic checks, revision metrics, plus the hand-written gap analysis
// (notes/vab-gaps.md) and method notes (notes/vab-method.md).
//
// Usage: VAB_TASK=vab-t2 node vab-report.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { P, readJson, SC, topicById } from './lib.mjs';

const TASK = topicById(process.env.VAB_TASK ?? 'vab-t1');
// Same folders as vab-eval.mjs: Task 1 keeps its original names.
const VAB = join(SC, TASK.id === 'vab-t1' ? 'vab' : TASK.id);
const OUT = join(SC, TASK.id === 'vab-t1' ? 'report-vab-task1.md' : `report-${TASK.id}.md`);
const COLS = [
  ['run1-v1', '我们 run1 · v1'], ['run1-v2', '我们 run1 · v2'], ['run2-v1', '我们 run2 · v1'], ['run2-v2', '我们 run2 · v2'], ['grok', 'Grok（仅 Stage A）'],
];
const METRICS = [
  ['intent_alignment', 'Intent 意图对齐', 25], ['research_grounding', 'Research 研究与真实性', 15], ['planning_storytelling', 'Planning 规划与叙事', 20],
  ['visual_vfx', 'Visual/VFX 视觉与特效', 15], ['editing_sound', 'Editing/Sound 音画编排', 15], ['execution_delivery', 'Execution/Delivery 执行与交付', 10],
];
const REV = [['revision_compliance', 'Revision Compliance 修改到位'], ['content_preservation', 'Content Preservation 内容保留'], ['quality_improvement', 'Quality Improvement 质量提升']];
const n1 = (x) => (typeof x === 'number' ? (Math.round(x * 10) / 10).toString() : '—');
const n2 = (x) => (typeof x === 'number' ? x.toFixed(2) : '—');
// Judges saw the guard results under their library name; the report calls them the benchmark's automatic checks.
const cell = (s) => String(s ?? '—').replace(/TimelineBench\s*/g, '自动评估').replace(/\|/g, '｜').replace(/\n/g, ' ');

const data = Object.fromEntries(COLS.map(([k]) => [k, {
  ev: readJson(join(VAB, k, 'evidence.json'), null),
  sc: readJson(join(VAB, k, 'scores.json'), null),
}]));
const rev = Object.fromEntries(['run1', 'run2'].map((r) => [r, readJson(join(VAB, `${r}-revision.json`), null)]));
const runs = Object.fromEntries(['run1', 'run2'].map((r) => [r, readJson(join(P.runs, `${TASK.id}-${r}.json`), null)]));
const stageOf = (k) => { const m = /^(run\d)-v([12])$/.exec(k); return m ? runs[m[1]]?.stages?.[Number(m[2]) - 1] : null; };

const L = [];
const push = (...xs) => L.push(...xs);
push(`# VideoAgentBench v0.2 · Task ${TASK.id.replace('vab-t', '')}（${TASK.title}）评测报告`, '');
const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const introFile = join(P.notes, 'vab-intro.md');
if (existsSync(introFile)) push(`生成时间：${stamp}（北京时间）。`, '', readFileSync(introFile, 'utf8').trim(), '');
else push(`生成时间：${stamp}（北京时间）。被测：${runs.run1?.base ?? '（未知实例）'} 上的两次独立运行（${['run1', 'run2'].filter((r) => runs[r]).map((r) => `${r} 会话 ${runs[r].sessionId}`).join('，')}），每次 Stage A（原始提示词）→ v1，Stage B（修改反馈）→ v2；对照系统见最后一列。`, '');
push('**评分：** 用户自己的六项标准（Intent 25、Research 15、Planning 20、Visual/VFX 15、Editing/Sound 15、Execution/Delivery 10），每项 0–10 分，按权重折算成 100 分；修改阶段另评三项（0–10）。每个评审独立调用 3 次取平均。relay 上没有 gemini-3.5-pro，B 按要求回落到 gemini-3.5-flash。B 几乎总给满分，区分度很低，**结论以 A 为准**。', '');

/* ---------- table ---------- */
push('## 1. 对照总表', '');
push(`| 项目 | ${COLS.map((c) => c[1]).join(' | ')} |`, `|---|${COLS.map(() => '---').join('|')}|`);
const row = (label, f) => push(`| ${label} | ${COLS.map(([k]) => cell(f(data[k], k))).join(' | ')} |`);
const sect = (title) => push(`| **${title}** | ${COLS.map(() => '').join(' | ')} |`);
sect('自动评估（benchmark 5.4）');
row('交付（会话里的版本号）', (d, k) => (d.ev ? (k === 'grok' ? '已交付' : `已交付（会话第 ${d.ev.version} 版）`) : stageOf(k)?.reached === false ? '未进行' : '未交付'));
row('时长', (d) => (d.ev ? `${n1(d.ev.checks.probe.duration)} s` : '—'));
row('分辨率 / fps / 编码', (d) => (d.ev ? `${d.ev.checks.probe.width}x${d.ev.checks.probe.height} / ${d.ev.checks.probe.fps} / ${d.ev.checks.probe.videoCodec}+${d.ev.checks.probe.audioCodec ?? '无音轨'}` : '—'));
row('响度（ebur128 积分，LUFS）/ 真峰值', (d) => (d.ev?.checks.loudness ? `${d.ev.checks.loudness.integratedLufs}${d.ev.checks.loudness.integratedLufs <= -69 ? '（无声）' : ''} / ${d.ev.checks.loudness.truePeakDbtp ?? '—'} dBTP` : '—'));
row('语音占比（whisper）', (d) => (d.ev ? `${Math.round(d.ev.silent.speechShare * 100)}%` : '—'));
row('带配音的主镜头', (d) => d.ev?.silent.voShots ?? '（黑盒）');
row('⚠ 无旁白/静音成片', (d) => (d.ev ? (d.ev.silent.flag ? '**是**' : '否') : '—'));
row('内容守卫（静音、冻帧、重复画面、dead air、声道、人脸裁切）', (d) => (d.ev ? (d.ev.checks.tlb.error ? '出错' : d.ev.checks.tlb.passed ? '通过' : `未通过：${d.ev.checks.tlb.failed.join('、')}`) : '—'));
row('dead_air / mostly_silent / mostly_frozen', (d) => (d.ev?.checks.tlb.values ? `${d.ev.checks.tlb.values.dead_air} s / ${d.ev.checks.tlb.values.mostly_silent} / ${d.ev.checks.tlb.values.mostly_frozen}` : '—'));
row('全黑帧（中段，严格）', (d) => (d.ev ? `${d.ev.checks.strictBlackMid.length} 段${d.ev.checks.strictBlackMid.length ? '：' + d.ev.checks.strictBlackMid.map((b) => `${b.start.toFixed(1)}s ${b.frames} 帧`).join('，') : ''}（片头/尾 ${d.ev.checks.strictBlack.length - d.ev.checks.strictBlackMid.length}）` : '—'));
row('blackdetect 宽松阈值（参考）', (d) => (d.ev ? `${d.ev.checks.black.length} 段，${n1(d.ev.checks.black.reduce((a, b) => a + b.seconds, 0))} s` : '—'));
sect('过程（本阶段）');
row('用时 / 到出片', (d, k) => { const s = stageOf(k); return s?.reached ? `${n1(s.wallSeconds / 60)} 分钟 / ${n1(s.secondsToVideo / 60)} 分钟` : k === 'grok' ? '未知' : '—'; });
row('用户消息（预设回复）', (d, k) => { const s = stageOf(k); return s?.replies ? s.replies.map((x) => `「${x.text.length > 14 ? x.text.slice(0, 14) + '…' : x.text}」`).join(' ') : k === 'grok' ? '0（未提问）' : '—'; });
row('首条可见输出（第 1 条消息后）', (d, k) => { const s = stageOf(k); return s?.firstOutputMs?.turn1 != null ? `${n1(s.firstOutputMs.turn1 / 1000)} s` : '—'; });
row('最长沉默', (d, k) => { const s = stageOf(k); return s?.maxSilentGap ? `${n1(s.maxSilentGap.seconds)} s` : '—'; });
row('应用估算成本 USD', (d, k) => { const s = stageOf(k); return s?.cost ? `$${s.cost.totalUsd.toFixed(2)}` : k === 'grok' ? '未知' : '—'; });
for (const [judge, name] of [['judgeA', 'A Claude Opus 5.5（Claude Code）'], ['judgeB', 'B gemini-3.5-flash（relay）']]) {
  sect(`评审 ${name}（0–10）`);
  for (const [m, label] of METRICS) row(label, (d) => n1(d.sc?.[judge]?.metrics?.[m]?.value));
  row(`**加权总分 /100**（3 次）`, (d) => (d.sc?.[judge]?.ok ? `**${n1(d.sc[judge].total)}**（${d.sc[judge].totalSamples.map(n1).join(' / ')}）` : d.sc ? '评审失败' : '—'));
}
row('**A、B 平均 /100**', (d) => (d.sc?.judgeA?.ok && d.sc?.judgeB?.ok ? `**${n1((d.sc.judgeA.total + d.sc.judgeB.total) / 2)}**` : '—'));
row('参考：A 经 relay 通道算的 /100', (d) => n1(d.sc?.judgeA_relay?.total));
row('补充：C gemini-3.1-pro-preview /100（3 次）', (d) => (d.sc?.judgeC?.ok ? `${n1(d.sc.judgeC.total)}（${d.sc.judgeC.totalSamples.map(n1).join(' / ')}）` : '—'));
sect('隐藏关注点（A / B，多数票）');
const verdict = (d, j, id) => { const s = d.sc?.[j]; if (!s?.ok) return '—'; const votes = s.samples.filter((x) => x.ok).map((x) => x.data.hidden_points?.find((h) => h.id === id)?.verdict).filter(Boolean); const rank = { no: 0, partial: 1, yes: 2 }; votes.sort((a, b) => rank[a] - rank[b]); const v = votes[Math.floor((votes.length - 1) / 2)]; return { yes: '✓', partial: '△', no: '✗' }[v] ?? '—'; };
const hidden = TASK.hidden;
hidden.forEach((h, i) => row(`H${i + 1} ${h.replace(/^是否/, '').replace(/。$/, '')}`, (d) => `${verdict(d, 'judgeA', `H${i + 1}`)} / ${verdict(d, 'judgeB', `H${i + 1}`)}`));
sect('修改阶段（v2 对 v1，0–10）');
for (const [m, label] of REV) row(label, (d, k) => { const r = /-v2$/.test(k) ? rev[k.slice(0, 4)] : null; return r ? `A ${n1(r.judgeA?.metrics?.[m]?.value)} / B ${n1(r.judgeB?.metrics?.[m]?.value)}${r.judgeC?.ok ? ` / C ${n1(r.judgeC.metrics?.[m]?.value)}` : ''}` : '—'; });
row('镜头复用（v2 中原样沿用 v1 的比例）', (d, k) => { const r = /-v2$/.test(k) ? rev[k.slice(0, 4)] : null; return r?.diff ? `${Math.round(r.diff.reusedShare * 100)}%（复用 ${r.diff.reused.length}，重做 ${r.diff.changed.length}，新增 ${r.diff.added.length}，删 ${r.diff.removed.length}）` : '—'; });
push('', '说明：✓ 做到、△ 部分、✗ 没做到。成本是应用账本的估算（写实镜头多为 relay 实际账单），不含评审费用。Grok 的过程信息只来自对话截图转述，没有日志、成本和耗时。', '');

/* ---------- gaps & notes ---------- */
for (const [file, title] of [['vab-gaps.md', '## 2. 最大的差距'], ['vab-method.md', '## 3. 方法、可信度与局限']]) {
  const p = join(P.notes, file);
  if (existsSync(p)) push(title, '', readFileSync(p, 'utf8').trim(), '');
}

/* ---------- per-video judge notes ---------- */
push('## 4. 各视频评审要点（评审 A 第一次调用的理由；B、C 的分数见总表）', '');
for (const [k, label] of COLS) {
  const d = data[k];
  if (!d.sc?.judgeA?.ok) continue;
  const s0 = d.sc.judgeA.samples.find((x) => x.ok);
  push(`### ${label}`, '');
  for (const [m, l] of METRICS) push(`- ${l}：${n1(d.sc.judgeA.metrics[m].value)}。${cell(s0.reasons[m])}`);
  const errs = s0.data.factual_errors ?? [];
  if (errs.length) push(`- 事实问题：${errs.map((e) => `[${e.time}] ${cell(e.claim)} → ${cell(e.problem)}`).join('；')}`);
  push('');
}
for (const r of ['run1', 'run2']) {
  const x = rev[r];
  if (!x?.judgeA?.ok) continue;
  const s0 = x.judgeA.samples.find((y) => y.ok);
  push(`### ${r} 修改阶段（Judge A）`, '');
  for (const [m, l] of REV) push(`- ${l}：${n1(x.judgeA.metrics[m].value)}。${cell(s0.reasons[m])}`);
  push(`- 开头问题：${s0.data.opening_fixed?.verdict}，${cell(s0.data.opening_fixed?.evidence)}`, `- 轨道变化讲清：${s0.data.orbit_clearer?.verdict}，${cell(s0.data.orbit_clearer?.evidence)}`);
  if (s0.data.unnecessary_changes?.length) push(`- 不必要的改动：${s0.data.unnecessary_changes.map(cell).join('；')}`);
  if (s0.data.regressions?.length) push(`- 退步：${s0.data.regressions.map(cell).join('；')}`);
  push('');
}
writeFileSync(OUT, L.join('\n'));
console.log(`report -> ${OUT}`);
