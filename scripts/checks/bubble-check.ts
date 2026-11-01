// Checks what the chat shows of the agent's text (src/agent/agent.ts cleanBubble) for a user writing Chinese:
// planning notes the model wrote in English before its message are cut, real messages that start with brand names,
// model numbers or an English slogan are kept as they are. Usage: npx tsx scripts/checks/bubble-check.ts
import { cleanBubble } from '../../src/agent/agent.ts';

const user = '帮我做个视频';
const CASES: Array<[string, string, string]> = [
  ['English notes with a few Chinese words inside, then the message',
    'bash\nNeed brief card? Key ambiguity: which app/channel (WeChat hospital public account, 健康平台 etc.), audience (elderly?), length. Ask a brief card. First message then ask_user.我想先确认两件事：挂号的渠道各家医院不太一样。',
    '我想先确认两件事：挂号的渠道各家医院不太一样。'],
  ['notes that start in Chinese, glued to the message by a Latin full stop',
    '民宿名 (input), 平台 (抖音竖版/小红书竖版/B站横版), 风格 (治愈慢生活/文艺清新/轻奢度假). Length? Max 3 questions. Could combine platform+length... Prioritize: name, platform/length, style. Mention voiceover default. Let\'s do labels: 店名 input, 平台 options "抖音竖版30秒","小红书竖版45秒","B站横版60秒", 风格.大理民宿的片子，画面基本就是洱海、苍山、院子和房间这几样。',
    '大理民宿的片子，画面基本就是洱海、苍山、院子和房间这几样。'],
  ['English self-talk only', 'Let me check the plan first. Then call save_plan.', ''],
  ['a brand at the start', 'NewsBreak 的落版做好了，你看看效果。', 'NewsBreak 的落版做好了，你看看效果。'],
  ['a short English word glued on', 'OK.那我先把剧本写出来。', 'OK.那我先把剧本写出来。'],
  ['model names and numbers', 'iPhone 15 Pro Max vs. Galaxy S25 Ultra.这两台的对比视频我来做。', 'iPhone 15 Pro Max vs. Galaxy S25 Ultra.这两台的对比视频我来做。'],
  ['an English slogan quoted', '片尾写 Work Safe. Get Home.然后接品牌 logo，你看行不行。', '片尾写 Work Safe. Get Home.然后接品牌 logo，你看行不行。'],
  ['a slogan at the start', 'Work Safe. Get Home. 这句口号我放在结尾。', 'Work Safe. Get Home. 这句口号我放在结尾。'],
  ['voice marks never shown', '夏天再来一碗凉粉，<#0.3#>红油一浇。', '夏天再来一碗凉粉，红油一浇。'],
];

let failed = 0;
for (const [what, input, want] of CASES) {
  const got = cleanBubble(input, user);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`}`);
}
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log('All bubble checks passed');
