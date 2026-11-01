export interface Bot {
  id: string;
  name: string;
  title: string;
  /** Shown on the profile page; the full behaviour lives in the bot's system prompt. */
  description: string;
  /** Gradient behind the bot's icon. */
  avatar: { from: string; to: string };
}

export const BOTS: Bot[] = [
  {
    id: 'video',
    name: 'Video Bot',
    title: '视频制作',
    description:
      '根据文字描述生成各类视频，包括宣传、讲解、祝福、故事短片与 MV，时长不限。支持多轮修改，仅重新制作受影响的镜头并生成新版本。文字、图表与动画镜头由代码精确绘制，人物与场景使用写实镜头。',
    avatar: { from: '#6366f1', to: '#8b5cf6' },
  },
];

export const DEFAULT_BOT = BOTS[0]!.id;
export const botById = (id: string | undefined) => BOTS.find((b) => b.id === id) ?? BOTS[0]!;
