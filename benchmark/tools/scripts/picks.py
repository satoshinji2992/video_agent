# Final selection for the v1 packs: which attempt became which shipped file, why other attempts were
# rejected, and what the speech checks heard. Read by finalize.py.

T2_PICKS = [
    # final name, spec id, attempt item (task/id/try), post-processing
    ('clip01_storefront', 'c01', 't2/c01/try1', None),
    ('clip02_walk_in', 'c02', 't2/c02/try1', None),
    ('clip03_interior_morning', 'c03', 't2/c03/try1', None),
    ('clip04_setup', 'c04', 't2/c04/try1', None),
    ('clip05_chalkboard', 'c05', 't2/c05/try1', None),
    ('clip06_grinding', 'c06', 'probe/grinding_5s/try1', None),
    ('clip07_espresso', 'c07', 't2/c07/try1', None),
    ('clip08_milk_steaming', 'c08', 't2/c08/try2', None),
    ('clip09_latte_art', 'c09', 't2/c09/try2', None),
    ('clip10_latte_art_2', 'c10', 't2/c10/try1', None),
    ('clip11_pour_over', 'c11', 't2/c11/try1', None),
    ('clip12_window_seat', 'c12', 't2/c12/try1', {'trim_head_s': 0.8, 'reason': '原片 0.4–0.6 秒处有生成瑕疵（杯子和桌面出现斑驳的叠影），裁掉开头 0.8 秒；视频用 x265 重新编码为与其他片段相同的 HEVC Main 10（10-bit，CRF 16），音频直接复制原始 AAC 流（0.8 秒正好是 25 个 AAC 帧，没有重新编码）。'}),
    ('clip13_window_seat_2', 'c13', 't2/c13/try1', None),
    ('clip14_cinnamon_roll', 'c14', 't2/c14/try1', None),
    ('clip15_misc', 'c15', 't2/c15/try1', None),
    ('clip16_neighbour', 'c16', 't2/c16/try1', None),
    ('clip17_takeaway', 'c17', 't2/c17/try3', None),
    ('clip18_friends', 'c18', 't2/c18/try1', None),
]

T3_PICKS = [
    ('clip01_corridor_walk', 'k01', 't3/k01/try1', None),
    ('clip02_enter_room', 'k02', 't3/k02/try1', None),
    ('clip03_keys', 'k03', 't3/k03/try1', None),
    ('clip04_mug', 'k04', 't3/k04/try1', None),
    ('clip05_mug_2', 'k05', 't3/k05/try1', None),
    ('clip06_sofa_reading', 'k06', 't3/k06/try1', None),
    ('clip07_clock_lookup', 'k07', 't3/k07/try3', None),
    ('clip08_clock', 'k08', 't3/k08/try1', None),
    ('clip09_window', 'k09', 't3/k09/try1', None),
    ('clip10_leave_room', 'k10', 't3/k10/try1', None),
    ('clip11_livingroom_empty', 'k11', 't3/k11/try1', None),
    ('clip12_corridor_empty', 'k12', 't3/k12/try1', None),
]

# Ambience WAVs: name, source attempt, start (s), duration (s), description
AMBIENCE = [
    ('room_tone.wav', 't3/a1/try1', 0.3, 10.1, '客厅底噪（安静房间，远处很轻的城市声）'),
    ('clock_ticking.wav', 't3/a2/try1', 0.5, 15.0, '挂钟滴答声（每秒一下）'),
    ('corridor_hum_footsteps.wav', 't3/a3/try1', 0.5, 15.0, '走廊吸顶灯电流声，中段有电梯运行声，后段有远处脚步声'),
    ('fridge_hum.wav', 't3/a4/try1', 0.5, 15.0, '冰箱压缩机的低沉嗡嗡声'),
]
AMBIENCE_TARGET = {'I': -30.0, 'TP': -3.0, 'LRA': 11.0}

# Why attempts that were not shipped were rejected (refusals are recorded from the log itself).
REJECTED = {
    't2/c08/try1': '背景是摆满酒瓶的吧台，和店里的白墙、浅色原木吧台不一致；围裙是深灰色。',
    't2/c09/try1': '拉花的人脸部占画面上方，长相和描述的男店主（黑框眼镜）不符；拉出的是树叶图案而不是爱心；背景吧台和店里不一致。',
    't2/c17/try1': '吧台玻璃罩里是可颂，菜单上没有这个产品，会给参测 Agent 提供与店铺资料矛盾的产品信息。',
    't2/c17/try2': '顾客的肩包是类似奢侈品牌老花图案的帆布包，按"避免真实品牌"的要求重拍。',
    't3/k07/try1': '拍成了全身景而不是中景；挂钟挂在窗户旁边，和客厅主镜头里挂钟在沙发正上方的位置不一致。',
    't3/k07/try2': '中景侧脸，但她抬头看向画面右上方，而挂钟在她身后的左上方，视线方向和挂钟位置矛盾。',
}

# Probes that were refused at submit time (no generation, no charge) and what they established.
PROBE_FINDINGS = [
    '参考图里有写实人脸时，服务端拒绝（"may contain real person"）：店主肖像作为 reference_image 被拒，作为首帧也被拒。',
    '首帧和参考图不能在同一个任务里混用（"first/last frame content cannot be mixed with reference media content"）。',
    '只有背影、看不到正脸的人物首帧（clip05 黑板）被接受。',
]

# On-camera speech: the line written into the prompt and what Whisper (whisper-1 via the relay) heard.
SPEECH = {
    'c04': {'scripted': ['靠窗那排也放下来吧？', '嗯，都放下来。'], 'heard': '靠窗那排也放下来吧 嗯 都放下来', 'method': 'whisper-1，自动识别语言'},
    'c10': {'scripted': ['啧，这杯歪了。'], 'heard': '这边歪了。', 'method': 'whisper-1，中文提示词'},
    'c15': {'scripted': ['诶，怎么在录？'], 'heard': '诶 怎么在录', 'method': 'whisper-1，自动识别语言'},
    'c16': {'scripted': ['你们哪天开呀？', '十五号开，阿姨到时候来喝杯热的。'], 'heard': '你们哪天开呀? 十五号开,阿姨到时候来喝杯热的', 'method': 'whisper-1，自动识别语言'},
    'c17': {'scripted': ['好香啊，明天上班前再来。', '好嘞，慢走啊。'], 'heard': '好香啊，明天上班前再来。好嘞，慢走啊。', 'method': 'whisper-1，截取对白段并用与台词无关的中文提示词（"以下是普通话。"）；自动识别时被误判为英语并输出英文翻译'},
    'c18': {'scripted': ['阿梅，这个桂花拿铁好喝！', '好喝就多来。'], 'heard': '（开头一句是听不清的嘈杂聊天）好吃吧。反正是跟桂花拿铁有关系。嗯。阿妹，这个桂花拿铁好喝。好喝就多来。', 'method': 'whisper-1，中文提示词（自动识别时被误判为英语并输出了英文翻译）'},
}
