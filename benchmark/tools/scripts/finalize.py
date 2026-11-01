#!/usr/bin/env python3
"""Assembles the frozen v1 packs from the accepted attempts.

Copies the chosen Seedance takes into assets/footage (byte-identical unless picks.py names a post step),
builds the ambience WAVs, copies the generation inputs into evaluator/inputs, probes and hashes every file,
and writes evaluator/manifest.json and evaluator/overview.png for Task 2 and Task 3.
Run with: python3 -I finalize.py   (refuses to overwrite an existing shipped file unless --rebuild is given).
"""
import hashlib, json, os, shutil, subprocess, sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import picks  # noqa: E402
import analyze  # noqa: E402

GEN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # benchmark/tools
PACK = os.path.join(os.path.dirname(GEN), 'packs')
W = f'{GEN}/work'
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
REBUILD = '--rebuild' in sys.argv
BUILD_DATE = '2026-11-01'


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def ffprobe(p):
    j = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', p]).stdout)
    v = next((s for s in j['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in j['streams'] if s['codec_type'] == 'audio'), None)
    out = {'duration_s': round(float(j['format']['duration']), 3), 'size_bytes': int(j['format']['size']), 'has_audio': a is not None}
    if v:
        num, den = (int(x) for x in v['avg_frame_rate'].split('/'))
        out.update({'video_codec': v['codec_name'], 'profile': v.get('profile'), 'pix_fmt': v.get('pix_fmt'), 'width': v['width'], 'height': v['height'],
                    'fps': round(num / den, 3) if den else None})
    if a:
        out.update({'audio_codec': a['codec_name'], 'sample_rate': int(a['sample_rate']), 'channels': a['channels']})
    return out


def loud(p):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', p, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], capture_output=True, text=True)
    t = r.stderr[r.stderr.rindex('{'):]
    j = json.loads(t[: t.index('}') + 1])
    return {'integrated_lufs': float(j['input_i']), 'true_peak_dbtp': float(j['input_tp']), 'lra_lu': float(j['input_lra'])}


attempts = [json.loads(l) for l in open(f'{GEN}/log/attempts.jsonl')]
by_item = {a['item']: a for a in attempts}
stills_log = [json.loads(l) for l in open(f'{GEN}/log/stills.jsonl')]
usage = json.load(open(f'{GEN}/log/usage.json')) if os.path.exists(f'{GEN}/log/usage.json') else {}
specs = {s['id']: s for f in ('t2.json', 't3.json', 'probe.json') for s in json.load(open(f'{GEN}/specs/{f}'))}


def still_record(path):
    """Generation record (model, prompt) of a still, by file name."""
    name = os.path.basename(path)
    for r in stills_log:
        if r.get('ok') and any(os.path.basename(f['path']) == name for f in r['files']):
            return {'model': r['model'], 'prompt': r['prompt'], 'reference_images': [os.path.basename(x) for x in r.get('refs', [])]}
    return None


K_CNY = 0.15592  # CNY per (24 x seconds + 1) at 1080p; every one of the 28 billed records fits this exactly
CNY_PER_USD = 7.2


def cost(a):
    u = usage.get(a.get('taskId') or '', {})
    if u.get('amount') is not None:
        return {'cny': round(u['amount'], 2), 'usd': round(u['amount'] / CNY_PER_USD, 2), 'basis': '中转站账单查询（实际扣费）'}
    if a.get('usd') is not None and a.get('basis') == 'actual':
        return {'cny': round(a['usd'] * CNY_PER_USD, 2), 'usd': round(a['usd'], 2), 'basis': '实际扣费（生成时查询）'}
    if a.get('taskId'):
        cny = K_CNY * (24 * a['seconds'] + 1)
        return {'cny': round(cny, 2), 'usd': round(cny / CNY_PER_USD, 2),
                'basis': '账单查询一直返回 429，按计费公式推算：元 = 0.15592 ×（24 × 秒数 + 1），全部 28 条实际账单都与此公式一致'}
    return None


def attempt_history(task, spec_id, chosen_item):
    rows = []
    for a in attempts:
        if a['task'] == task and a['id'] == spec_id or (spec_id == 'c06' and a['item'] == 'probe/grinding_5s/try1'):
            ran = bool(a.get('taskId')) or a['ok']
            outcome = '采用' if a['item'] == chosen_item else ('提交时被拒（未生成，未计费）' if not ran else '弃用')
            rows.append({'attempt': a['try'], 'item': a['item'], 'outcome': outcome,
                         'reason': picks.REJECTED.get(a['item']) if outcome == '弃用' else (a.get('error') if not ran else None),
                         'provider_task_id': a.get('taskId'), 'seconds_requested': a['seconds'], 'cost': cost(a),
                         'prompt': a['prompt'] if a['item'] != chosen_item else '（同上）'})
    return rows


INPUT_NAMES = {
    f'{W}/frames/storefront_a-2_916.png': ('storefront_firstframe.png', f'{W}/stills/storefront_a-2.png', '居中裁成 9:16（864×1536）'),
    f'{W}/stills/interior_a-1.jpg': ('interior_morning.jpg', None, None),
    f'{W}/frames/chalk_ff-2_916.png': ('chalkboard_firstframe.png', f'{W}/stills/chalk_ff-2.png', '居中裁成 9:16（864×1536）'),
    f'{W}/stills/window_seat-1.jpg': ('window_seat.jpg', None, None),
    f'{W}/frames/window_seat-1_overexposed.jpg': ('window_seat_overexposed.jpg', f'{W}/stills/window_seat-1.jpg',
                                                  'ffmpeg 模拟手机测光失误：curves 提亮并压掉高光（0→0.16，0.3→0.78，0.55→0.98），饱和度 0.7，叠加 25% 高斯模糊光晕'),
    f'{W}/frames/c09_first.png': ('latte_art_firstframe.png', None, 'clip09_latte_art 的第一帧（让重拍的 clip10 机位完全一致）'),
    f'{W}/stills/photo_interior-1.jpg': ('interior_open.jpg', None, None),
    f'{W}/stills/livingroom_a-1.jpg': ('livingroom_plate.jpg', None, None),
    f'{W}/stills/corridor_b-1.jpg': ('corridor_plate.jpg', None, None),
    f'{W}/stills/kitchen_a-1.jpg': ('kitchen_plate.jpg', None, None),
    f'{W}/stills/clock_c-2.jpg': ('clock_plate.jpg', None, None),
    f'{W}/stills/console_b-1.jpg': ('console_plate.jpg', None, None),
}


def input_entry(path, inputs_dir):
    name, parent, transform = INPUT_NAMES[path]
    dst = f'{inputs_dir}/{name}'
    if not os.path.exists(dst):
        shutil.copy2(path, dst)
    rec = still_record(parent or path)
    return {'file': f'evaluator/inputs/{name}', 'sha256': sha(dst), 'generated_by': rec,
            'derived': transform, **({'derived_from_sha256': sha(parent)} if parent else {})}


def overview(entries, out, cols, frame_w, label_fn, at_fn):
    tmp = f'{GEN}/tmp/overview'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    for i, e in enumerate(entries):
        src = f"{e['_task_dir']}/{e['file']}"
        t = at_fn(e)
        label = label_fn(e).replace(':', '\\:')
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{t:.2f}', '-i', src, '-frames:v', '1', '-vf',
             f"scale={frame_w}:-2,pad=iw:ih+34:0:0:white,drawtext=fontfile={FONT}:text='{label}':fontsize={12 if frame_w < 300 else 15}:fontcolor=black:x=6:y=h-26",
             f'{tmp}/{i:02d}.png'])
    rows = -(-len(entries) // cols)
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', f'{tmp}/%02d.png', '-vf', f'tile={cols}x{rows}:padding=6:color=white', '-frames:v', '1', out])
    shutil.rmtree(tmp, ignore_errors=True)


def build_footage(task_dir, task, pick_list, extra_checks):
    footage = f'{task_dir}/assets/footage'
    inputs_dir = f'{task_dir}/evaluator/inputs'
    os.makedirs(inputs_dir, exist_ok=True)
    out = []
    for name, spec_id, item, post in pick_list:
        a = by_item[item]
        assert a['ok'], item
        dst = f'{footage}/{name}.mp4'
        if os.path.exists(dst) and not REBUILD:
            raise SystemExit(f'{dst} exists; v1 files are never regenerated in place (use --rebuild only while building v1)')
        if post:
            trimmed = a['out'].replace('.mp4', '_trim.mp4')
            assert os.path.exists(trimmed), trimmed
            shutil.copy2(trimmed, dst)
        else:
            shutil.copy2(a['out'], dst)
        spec = specs[spec_id]
        gen = {'model': a['model'], 'resolution': a['resolution'], 'draft_mode': a['draft'], 'aspect': a['aspect'],
               'seconds_requested': a['seconds'], 'generate_audio': a['audio'], 'prompt': a['prompt'], 'provider_task_id': a['taskId'],
               'source_attempt': item, 'source_sha256': a['sha256']}
        if a.get('firstFrame'):
            gen['first_frame'] = input_entry(a['firstFrame'], inputs_dir)
        if a.get('refs'):
            gen['reference_images'] = [input_entry(r, inputs_dir) for r in a['refs']]
        hist = attempt_history(a['task'], spec_id, item)
        ran = [h for h in hist if not h['outcome'].startswith('提交时被拒')]
        e = {'file': f'assets/footage/{name}.mp4', 'sha256': sha(dst), 'intended_role': spec['role'], 'intended_defect': spec.get('defect', 'none'),
             'generation': gen, 'retries': max(0, len(ran) - 1), 'attempts': hist,
             'post_processing': post, 'ffprobe': ffprobe(dst), '_task_dir': task_dir, '_id': spec_id}
        checks = {'contact_sheet': '6 帧联系表（4%–96% 均匀取帧）已人工看过',
                  'shake_px_per_frame': analyze.shake(dst)}
        if a.get('firstFrame'):
            checks['early_frames'] = '首帧生成的片段：0.1–1.4 秒内 8 帧已人工看过（排查首帧过渡瑕疵）'
        if spec_id in picks.SPEECH:
            checks['speech'] = picks.SPEECH[spec_id]
        checks.update(extra_checks.get(spec_id, {}))
        e['checks'] = checks
        out.append(e)
        print(f"{name}: {e['ffprobe']['width']}x{e['ffprobe']['height']} {e['ffprobe']['fps']}fps {e['ffprobe']['duration_s']}s audio={e['ffprobe']['has_audio']} retries={e['retries']}")
    return out


def strip(entries):
    return [{k: v for k, v in e.items() if not k.startswith('_')} for e in entries]


def ambience(task_dir):
    out = []
    amb = f'{task_dir}/assets/ambience'
    os.makedirs(amb, exist_ok=True)
    tgt = picks.AMBIENCE_TARGET
    for name, item, start, dur, desc in picks.AMBIENCE:
        a = by_item[item]
        assert a['ok'], item
        dst = f'{amb}/{name}'
        if os.path.exists(dst) and not REBUILD:
            raise SystemExit(f'{dst} exists')
        seg = f'{GEN}/tmp/{name}.seg.wav'
        fade = f'afade=t=in:d=0.3,afade=t=out:st={dur - 0.5:.2f}:d=0.5'
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', f'{start}', '-t', f'{dur}', '-i', a['out'], '-vn', '-af', fade,
             '-ar', '48000', '-c:a', 'pcm_s24le', seg])
        m = loud(seg)
        gain = tgt['I'] - m['integrated_lufs']
        limited = m['true_peak_dbtp'] + gain > tgt['TP']
        if limited:
            gain = tgt['TP'] - m['true_peak_dbtp']
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', seg, '-af', f'volume={gain:.2f}dB', '-ar', '48000', '-c:a', 'pcm_s16le', dst])
        os.remove(seg)
        after = loud(dst)
        spec = specs[a['id']]
        out.append({'file': f'assets/ambience/{name}', 'sha256': sha(dst), 'description': desc,
                    'source': {'attempt': item, 'provider_task_id': a['taskId'], 'model': a['model'], 'resolution': a['resolution'],
                               'seconds_requested': a['seconds'], 'prompt': a['prompt'], 'first_frame': os.path.basename(a['firstFrame']),
                               'source_sha256': a['sha256'], 'source_audio': 'AAC 32 kHz 立体声（Seedance 原生音轨）', 'cost': cost(a),
                               'note': '只取音轨，画面不随包提供'},
                    'extraction': {'start_s': start, 'duration_s': dur, 'fades': '淡入 0.3 秒，淡出 0.5 秒', 'resample': '48 kHz',
                                   'loudness_normalisation': f"按 EBU R128 测得的整体响度做固定增益（不压缩、不限幅）：目标 {tgt['I']} LUFS，真峰值不超过 {tgt['TP']} dBTP",
                                   'gain_db': round(gain, 2), 'peak_limited_gain': limited, 'before': m},
                    'loudness_after': after, 'format': ffprobe(dst), 'role': spec['role']})
        print(f"{name}: {after}")
    return out


def summary(entries):
    hs = [h for e in entries for h in e['attempts'] if not h['outcome'].startswith('提交时被拒')]
    secs = sum(h['seconds_requested'] for h in hs)
    usd = sum((h['cost'] or {}).get('usd') or 0 for h in hs)
    cny = sum((h['cost'] or {}).get('cny') or 0 for h in hs)
    return secs, usd, cny


if __name__ == '__main__':
    # ---------- Task 2 ----------
    t2 = f'{PACK}/task2-coffee'
    t2_extra = {
        'c01': {'text_check': '招牌「两口咖啡」在 6 帧里都清楚、无变形（人工看过）'},
        'c05': {'text_check': '最后一帧全分辨率裁图核对黑板：两口咖啡；饮品 美式18 拿铁24 燕麦拿铁26 桂花拿铁28 今日手冲32 热可可20；甜点 肉桂卷16 司康12，与 store_profile.md 一致'},
        'c12': {'glitch': '原片 0.38–0.62 秒有斑驳叠影，已裁掉开头 0.8 秒；裁后 8 帧早段复查干净'},
        'c13': {'defect_check': '全片过曝，窗外和桌面发白，靠近肉桂卷时局部恢复；属于手机测光失误的样子'},
        'c02': {'defect_check': '晃动指标约为其他手持素材的 4–40 倍（见 shake_px_per_frame）'},
        'c10': {'defect_check': '与 clip09 同一首帧、同机位；最终图案偏到一边、不对称，明显不如 clip09 的爱心'},
        'c15': {'defect_check': '镜头朝地板，画面下方被手指挡住，内容无用'},
        'c17': {'content_check': '玻璃罩里是肉桂卷（与菜单一致）；顾客的包为纯色'},
    }
    t2_entries = build_footage(t2, 't2', picks.T2_PICKS, t2_extra)
    # assets other than footage
    st = f'{W}/stills'
    other = []
    for rel, src, transform in [
        ('assets/menu.png', f'{st}/menu_a-2.png', None),
        ('assets/logo.png', f'{st}/logo_a-2.png', None),
        ('assets/photos/storefront.jpg', f'{st}/photo_storefront-1.png', '从顶部裁成 3:4（1024×1365）并转 JPEG'),
        ('assets/photos/interior.jpg', f'{st}/photo_interior-1.jpg', '转存 JPEG（质量 2）'),
        ('assets/photos/owners.jpg', f'{st}/photo_owners-1.png', '居中裁成 3:4（1024×1365）并转 JPEG'),
        ('assets/photos/beans.jpg', f'{st}/photo_beans-1.jpg', '转存 JPEG（质量 2）'),
        ('assets/photos/latte_topdown.jpg', f'{st}/photo_latte-1.jpg', '转存 JPEG（质量 2）'),
    ]:
        p = f'{t2}/{rel}'
        w, h = run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]).stdout.strip().split(',')
        other.append({'file': rel, 'sha256': sha(p), 'width': int(w), 'height': int(h), 'generated_by': still_record(src), 'derived': transform,
                      'source_sha256': sha(src)})
    other.append({'file': 'assets/store_profile.md', 'sha256': sha(f'{t2}/assets/store_profile.md'), 'generated_by': '构建者手写（虚构店铺）'})
    other[0]['text_check'] = '人工逐字核对：标题、两个小标题和 8 个品名、价格与 store_profile.md 完全一致'
    other[1]['text_check'] = '人工核对：店名「两口咖啡」四字正确，无其他文字'
    other[2]['text_check'] = '人工放大核对：招牌「两口咖啡」正确'
    overview(t2_entries, f'{t2}/evaluator/overview.png', 6, 280,
             lambda e: f"{e['file'].split('/')[-1][:-4]}  [{e['intended_defect']}]",
             lambda e: e['ffprobe']['duration_s'] * {'c16': 0.75, 'c18': 0.75, 'c17': 0.25, 'c04': 0.3}.get(e['_id'], 0.5))
    secs2, usd2, cny2 = summary(t2_entries)
    m2 = {'pack': 'task2-coffee', 'version': 'v1', 'built': BUILD_DATE,
          'generator': {'video': 'Seedance 2.5（doubao-seedance-2-5-260628），经中转站调用', 'stills': 'gpt-image-2（菜单、Logo、招牌、店主照片、黑板首帧）与 Seedream 5.0（doubao-seedream-5-0-260128，写实场景）',
                        'resolution': '1080p（1080×1920，竖屏 9:16），样片（draft）模式关闭', 'audio': 'Seedance 同步生成的现场声'},
          'probe_findings': picks.PROBE_FINDINGS,
          'footage': strip(t2_entries), 'other_assets': other,
          'totals': {'clips': len(t2_entries), 'seedance_seconds_generated_incl_rejected': secs2, 'cny': round(cny2, 2), 'usd_at_7.2': round(usd2, 2)}}
    json.dump(m2, open(f'{t2}/evaluator/manifest.json', 'w'), ensure_ascii=False, indent=2)

    # ---------- Task 3 ----------
    t3 = f'{PACK}/task3-glitch'
    plates = {'k01': 'corridor_b-1.jpg', 'k02': 'livingroom_a-1.jpg', 'k03': 'console_b-1.jpg', 'k04': 'kitchen_a-1.jpg', 'k05': 'kitchen_a-1.jpg',
              'k08': 'clock_c-2.jpg', 'k10': 'livingroom_a-1.jpg', 'k11': 'livingroom_a-1.jpg', 'k12': 'corridor_b-1.jpg'}
    t3_extra = {}
    for k, plate in plates.items():
        item = next(i for n, s, i, _ in picks.T3_PICKS if s == k)
        t3_extra[k] = {'lock_vs_plate': analyze.lock(f'{st}/{plate}', by_item[item]['out']),
                       'lock_note': 'offset_px_1080p = 与首帧底图的整体位移（1080p 像素）；mad = 与底图的平均像素差（0–255，人物在画面里时会变大）'}
    t3_extra['k08']['second_hand'] = '红色秒针为连续扫动，实测约 6.9°/秒（真实挂钟 6°/秒），时针分针约指在十点十五分不动'
    t3_entries = build_footage(t3, 't3', picks.T3_PICKS, t3_extra)
    amb = ambience(t3)
    overview(t3_entries, f'{t3}/evaluator/overview.png', 4, 440,
             lambda e: e['file'].split('/')[-1][:-4],
             lambda e: e['ffprobe']['duration_s'] * {'k01': 0.7, 'k02': 0.75, 'k03': 0.4, 'k04': 0.45, 'k05': 0.45, 'k10': 0.45}.get(e['_id'], 0.5))
    secs3, usd3, cny3 = summary(t3_entries)
    amb_secs = sum(by_item[i]['seconds'] for _, i, *_ in picks.AMBIENCE)
    amb_usd = sum((cost(by_item[i]) or {}).get('usd') or 0 for _, i, *_ in picks.AMBIENCE)
    amb_cny = sum((cost(by_item[i]) or {}).get('cny') or 0 for _, i, *_ in picks.AMBIENCE)
    m3 = {'pack': 'task3-glitch', 'version': 'v1', 'built': BUILD_DATE,
          'generator': {'video': 'Seedance 2.5（doubao-seedance-2-5-260628），经中转站调用', 'stills': 'Seedream 5.0（doubao-seedream-5-0-260128）生成的空场景底图，用作首帧或参考图',
                        'resolution': '1080p（1920×1080，横屏 16:9），样片（draft）模式关闭', 'audio': 'Seedance 同步生成的现场声'},
          'probe_findings': picks.PROBE_FINDINGS,
          'locked_off_groups': [
              {'plate_clip': 'clip11_livingroom_empty.mp4', 'same_first_frame': ['clip02_enter_room.mp4', 'clip10_leave_room.mp4'], 'first_frame': 'evaluator/inputs/livingroom_plate.jpg'},
              {'plate_clip': 'clip12_corridor_empty.mp4', 'same_first_frame': ['clip01_corridor_walk.mp4'], 'first_frame': 'evaluator/inputs/corridor_plate.jpg'},
              {'plate_clip': None, 'same_first_frame': ['clip04_mug.mp4', 'clip05_mug_2.mp4'], 'first_frame': 'evaluator/inputs/kitchen_plate.jpg', 'note': '两条都从空台面开始、人物入画再出画，开头和结尾可当底板'},
              {'plate_clip': None, 'same_first_frame': ['clip03_keys.mp4'], 'first_frame': 'evaluator/inputs/console_plate.jpg', 'note': '开头和结尾画面里没有人'},
              {'plate_clip': None, 'same_first_frame': ['clip08_clock.mp4'], 'first_frame': 'evaluator/inputs/clock_plate.jpg'},
          ],
          'footage': strip(t3_entries), 'ambience': amb,
          'totals': {'clips': len(t3_entries), 'ambience_files': len(amb), 'seedance_seconds_generated_incl_rejected': secs3 + amb_secs,
                     'cny': round(cny3 + amb_cny, 2), 'usd_at_7.2': round(usd3 + amb_usd, 2)}}
    json.dump(m3, open(f'{t3}/evaluator/manifest.json', 'w'), ensure_ascii=False, indent=2)
    print(json.dumps({'t2': m2['totals'], 't3': m3['totals']}, ensure_ascii=False))
