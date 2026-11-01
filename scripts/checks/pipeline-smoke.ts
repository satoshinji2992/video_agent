// Exercises the studio tools end to end without the model: plan -> code shot -> mock Seedance shot -> assemble.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../../src/media/project.ts';
import { createStudio } from '../../src/tools/index.ts';
import { closeBrowser } from '../../src/render/renderer.ts';

const dir = process.env.SMOKE_DIR ?? join(tmpdir(), 'video-agent-smoke');
await rm(dir, { recursive: true, force: true });
const store = new ProjectStore(dir);
await store.init();
const events: string[] = [];
const server = createStudio({ store, sessionId: '00000000-0000-0000-0000-000000000000', emit: (e) => events.push(String(e.type)), requestApproval: async () => true, turnId: () => 'smoke' });
const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
const call = async (name: string, args: unknown) => {
  const t = tools[name]!;
  const fn = (t.handler ?? t.callback)!;
  const r = await fn(args, {});
  return r.content.map((c: { type: string; text?: string }) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;width:480px;height:854px;background:#1a1033;font-family:"Noto Sans CJK SC";overflow:hidden}
#t{position:absolute;left:40px;right:40px;top:300px;color:#fff;font-size:64px;font-weight:900;line-height:1.15}
#p{position:absolute;left:40px;top:520px;color:#ffcf4d;font-size:40px;font-weight:700}
</style></head><body><div id="t">秋天第一杯<br>芋泥啵啵</div><div id="p">限时 ¥12.9</div>
<script>const e=(x)=>1-Math.pow(1-Math.min(Math.max(x,0),1),3);
window.renderFrame=(t)=>{const a=e(t/0.8),b=e((t-0.6)/0.8);
document.getElementById('t').style.transform='translateY('+(60*(1-a))+'px)';document.getElementById('t').style.opacity=a;
document.getElementById('p').style.opacity=b;document.getElementById('p').style.transform='scale('+(0.8+0.2*b)+')';};</script></body></html>`;

const t0 = Date.now();
console.log(await call('save_plan', { title: '冒烟测试', aspect: '9:16', shots: [
  { id: 'hook', seconds: 3, kind: 'code', brief: '大字开场', caption: '秋天的第一杯，就它了' },
  { id: 'scene', seconds: 4, kind: 'seedance', brief: '咖啡馆窗边喝奶茶', caption: '芋泥满满一口下去' },
]}));
console.log(await call('render_code_shot', { shot_id: 'hook', html }), `(${Date.now() - t0} ms)`);
console.log(await call('generate_seedance_shot', { shot_id: 'scene', prompt: '秋日午后咖啡馆窗边，一杯紫色芋泥奶茶，暖光，慢推镜头' }));
console.log(await call('generate_seedance_shot', { shot_id: 'scene', prompt: '换个提示词' }));
console.log(await call('assemble_video', { silent_ok: true }), `(${Date.now() - t0} ms)`);
// Second round: change only the caption of one shot -> no re-render, new version.
console.log(await call('save_plan', { title: '冒烟测试', aspect: '9:16', subtitles: true, shots: [
  { id: 'hook', seconds: 3, kind: 'code', brief: '大字开场', caption: '秋天第一杯，选芋泥' },
  { id: 'scene', seconds: 4, kind: 'seedance', brief: '咖啡馆窗边喝奶茶', caption: '芋泥满满一口下去' },
]}));
console.log(await call('assemble_video', { silent_ok: true }), `(${Date.now() - t0} ms)`);
console.log('events:', [...new Set(events)].join(','));
await closeBrowser();
if (!events.includes('video')) { console.log('FAIL: no video was assembled'); process.exit(1); }
console.log(`ok: video assembled, project in ${dir}`);
