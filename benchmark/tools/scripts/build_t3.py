# Builds tools/specs/t3.json: Task 3 (time glitch) clip specs plus the ambience source clips.
# Paired shots share one first-frame still so the empty plate and the shot with the person match.
import json, os

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # benchmark/tools
os.chdir(TOOLS)
W = 'work'  # specs keep paths relative to benchmark/tools
ST = f'{W}/stills'
LIVING = f'{ST}/livingroom_a-1.jpg'
CORRIDOR = f'{ST}/corridor_b-1.jpg'
KITCHEN = f'{ST}/kitchen_a-1.jpg'
CLOCK = f'{ST}/clock_c-2.jpg'
CONSOLE = f'{ST}/console_b-1.jpg'

BASE = ('像普通人用手机拍的原始视频素材：手机自动曝光，色彩真实，没有调色，画质带一点手机的噪点。实时正常速度，不是慢动作。'
        '一个连续镜头，中间没有剪辑、没有转场。画面里没有任何字幕、文字或水印，没有任何特效。声音只有现场环境声，没有背景音乐。')
LOCKED = '横屏画面，手机固定在三脚架上拍摄，机位和构图从头到尾完全不动，没有推拉摇移，没有晃动。' + BASE
FIXED = '横屏画面，固定机位拍摄，机位和构图从头到尾完全不动，没有推拉摇移，没有晃动。' + BASE
WOMAN = ('一位二十八岁左右的中国女性（黑色齐肩直发，发尾刚到肩膀，穿浅灰色粗针织圆领毛衣、深蓝色直筒牛仔裤、白色帆布鞋）')
ROOM_REF = ('客厅环境和参考图片一致：浅灰色布艺沙发和米色毯子，白墙上挂着只有刻度、没有数字的白色圆形挂钟，'
            '小圆木茶几，挂着白色纱帘的大窗户，浅色木地板。阴天下午柔和的自然光，室内没开灯。')

clips = [
    dict(id='k01', slug='corridor_walk', seconds=10, role='走廊：女主朝镜头走来（与 k12 空镜同机位）', firstFrame=CORRIDOR,
         prompt='住宅楼的公共走廊，固定机位。' + WOMAN + '从走廊尽头朝镜头方向不紧不慢地走过来，手里拿着一串钥匙，'
                '一直走到离镜头不远的地方，在右侧一扇深灰色入户门前停下，转身面对那扇门。走廊里只有她一个人。'
                '现场声音：她的脚步声在走廊里轻轻回响，吸顶灯低低的电流声，远处隐约的电梯声。' + LOCKED),
    dict(id='k02', slug='enter_room', seconds=10, role='客厅：女主开门进屋、放钥匙（与 k11 空镜、k10 同机位）', firstFrame=LIVING,
         prompt='公寓客厅，固定机位。开始时客厅里没有人。两三秒后，画面左侧的白色入户门被从外面推开，' + WOMAN +
                '走进来，随手把门关上，把手里的一串钥匙放进门边玄关柜上的白色托盘里，然后慢慢走到客厅中间，站着环顾了一下房间。'
                '现场声音：开门和关门的声音，钥匙放进托盘的清脆声响，脚步声，墙上挂钟轻轻的滴答声。' + LOCKED),
    dict(id='k03', slug='keys', seconds=6, role='玄关柜近景：钥匙放进托盘', firstFrame=CONSOLE,
         prompt='玄关柜的近景，固定机位。一只女人的手（浅灰色粗针织毛衣的袖口）从画面右侧伸进来，把一串钥匙轻轻放进柜面上的白色陶瓷托盘里，'
                '钥匙碰到托盘发出清脆的声音，手停了一下，然后收回去，之后画面里没有人。'
                '现场声音：钥匙碰托盘的声音，房间里安静的环境声。' + LOCKED),
    dict(id='k04', slug='mug', seconds=8, role='厨房台面：拿起马克杯喝一口（第 1 条）', firstFrame=KITCHEN,
         prompt='开放式厨房的台面，固定机位。开始时画面里没有人。' + WOMAN + '从画面左侧走进来，站在台面后面，拿起台面上的白色马克杯，'
                '低头慢慢喝了一口，停顿一下，把杯子放回原来的位置，然后从画面左侧走出去。'
                '现场声音：脚步声，杯子拿起和放下时碰到台面的轻响，冰箱低低的嗡嗡声。' + LOCKED),
    dict(id='k05', slug='mug_2', seconds=8, role='厨房台面：同一动作的第 2 条（几乎相同，可做循环）', firstFrame=KITCHEN,
         prompt='开放式厨房的台面，固定机位。开始时画面里没有人。' + WOMAN + '从画面左侧走进来，站在台面后面，拿起台面上的白色马克杯，'
                '低头慢慢喝了一口，停顿一下，把杯子放回原来的位置，然后从画面左侧走出去。'
                '现场声音：脚步声，杯子拿起和放下时碰到台面的轻响，冰箱低低的嗡嗡声。' + LOCKED),
    dict(id='k06', slug='sofa_reading', seconds=8, role='沙发上看书（中景）', refs=[LIVING],
         prompt=ROOM_REF + '中景，从沙发斜前方拍：' + WOMAN + '盘腿坐在浅灰色布艺沙发上，腿上盖着米色毯子，低头安静地看一本书，'
                '过了一会儿翻了一页。现场声音：翻书声，墙上挂钟轻轻的滴答声，窗外很远的城市声音。' + FIXED),
    dict(id='k07', slug='clock_lookup', seconds=7, role='抬头看挂钟（中景，过肩）', refs=[LIVING],
         prompt=ROOM_REF + '中景，固定机位，从她背后略偏右的位置拍（过肩镜头）：' + WOMAN + '背对镜头站在浅灰色布艺沙发前，'
                '画面下方是她的后脑勺和肩膀，沙发正上方白墙上的白色圆形挂钟在画面上方正中（表盘上只有刻度、没有数字，红色秒针）。'
                '她慢慢抬起头，看向正前方墙上的挂钟，盯着看了几秒，头微微歪了一下。现场声音：挂钟清楚的滴答声，房间里很安静。' + FIXED),
    dict(id='k08', slug='clock', seconds=8, role='挂钟特写空镜（秒针走动）', firstFrame=CLOCK,
         prompt='墙上挂钟的特写，固定机位，画面完全不动。红色秒针一格一格地跳动，每秒走一格，实时速度；时针和分针不动。'
                '表盘上只有刻度，没有数字。现场声音：清晰、均匀的挂钟滴答声，房间里很安静。' + LOCKED),
    dict(id='k09', slug='window', seconds=8, role='窗前望向窗外（中景，侧后方）', refs=[LIVING],
         prompt=ROOM_REF + '中景，从她的侧后方拍：' + WOMAN + '站在挂着白色纱帘的大窗户前，一只手轻轻拨开纱帘，'
                '望着窗外阴天里的城市居民楼，静静地站着，过了一会儿慢慢转过头看向屋里。'
                '现场声音：窗外很远的城市声音和一点风声，房间里很安静。' + FIXED),
    dict(id='k10', slug='leave_room', seconds=8, role='客厅：女主开门离开（与 k02、k11 同机位）', firstFrame=LIVING,
         prompt='公寓客厅，固定机位。开始时客厅里没有人。' + WOMAN + '从镜头旁边、画面右下方走进画面，穿过客厅走到左侧的白色入户门前，'
                '打开门走出去，随手把门带上。之后客厅里又没有人了。现场声音：脚步声，开门和关门的声音，墙上挂钟轻轻的滴答声。' + LOCKED),
    dict(id='k11', slug='livingroom_empty', seconds=10, role='客厅空镜（干净底板，与 k02、k10 同机位）', firstFrame=LIVING,
         prompt='公寓客厅，固定机位，客厅里一直没有人，所有东西都静止不动。阴天下午柔和的自然光，光线几乎没有变化。'
                '现场声音：房间里安静的底噪，墙上挂钟轻轻的滴答声，窗外很远的城市声音。' + LOCKED),
    dict(id='k12', slug='corridor_empty', seconds=8, role='走廊空镜（干净底板，与 k01 同机位）', firstFrame=CORRIDOR,
         prompt='住宅楼的公共走廊，固定机位，走廊里一直没有人，吸顶灯稳定地亮着，所有东西都静止不动。'
                '现场声音：吸顶灯低低的电流嗡嗡声，远处电梯运行的声音和隐约的脚步声。' + LOCKED),
    # Ambience sources: longer empty takes whose audio becomes assets/ambience/*.wav (the picture is not shipped).
    dict(id='a1', slug='amb_room_tone', seconds=16, role='环境声来源：客厅底噪', firstFrame=LIVING,
         prompt='公寓客厅，固定机位，客厅里一直没有人，画面完全静止。声音：安静房间的底噪，窗外很远、很轻的城市声音。没有人声，没有音乐。' + LOCKED),
    dict(id='a2', slug='amb_clock_tick', seconds=16, role='环境声来源：挂钟滴答', firstFrame=CLOCK,
         prompt='墙上挂钟的特写，固定机位，红色秒针每秒走一格。声音：清晰、均匀的挂钟滴答声，每秒一下，房间里很安静。没有人声，没有音乐。' + LOCKED),
    dict(id='a3', slug='amb_corridor', seconds=16, role='环境声来源：走廊电流声与远处脚步', firstFrame=CORRIDOR,
         prompt='住宅楼的公共走廊，固定机位，走廊里一直没有人，画面静止。声音：吸顶灯低低的电流嗡嗡声，远处偶尔传来电梯运行的声音和隐约的脚步声。没有人说话，没有音乐。' + LOCKED),
    dict(id='a4', slug='amb_fridge', seconds=16, role='环境声来源：冰箱嗡嗡声', firstFrame=KITCHEN,
         prompt='开放式厨房的台面，固定机位，画面里一直没有人，画面静止。声音：冰箱压缩机低沉、持续的嗡嗡声，厨房里很安静。没有人声，没有音乐。' + LOCKED),
]
for c in clips:
    c.setdefault('task', 't3')
    c.setdefault('aspect', '16:9')
    c.setdefault('audio', True)
    c.setdefault('defect', 'none')
json.dump(clips, open('specs/t3.json', 'w'), ensure_ascii=False, indent=2)
print(len(clips), 'specs;', sum(c['seconds'] for c in clips if c['id'].startswith('k')), 's footage +', sum(c['seconds'] for c in clips if c['id'].startswith('a')), 's ambience sources')
