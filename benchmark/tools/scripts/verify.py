#!/usr/bin/env python3
"""Final consistency checks for the v1 packs. Prints one line per check and exits non-zero on any failure."""
import hashlib, json, os, re, subprocess, sys

_HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(_HERE, '..', '..', 'packs')
BENCH = os.path.join(_HERE, '..', '..', 'benchmark-v0.2.md')
fails = []


def check(ok, msg):
    print(('OK   ' if ok else 'FAIL ') + msg)
    if not ok:
        fails.append(msg)


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()


def probe(p):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', p], capture_output=True, text=True).stdout)
    v = next((s for s in j['streams'] if s['codec_type'] == 'video'), None)
    a = next((s for s in j['streams'] if s['codec_type'] == 'audio'), None)
    return v, a, float(j['format']['duration'])


# prompts verbatim from benchmark.md (blockquotes)
lines = open(BENCH, encoding='utf-8').read().split('\n')
spans = {'task1-dart/user_prompt.txt': (44, 48), 'task1-dart/revision_prompt.txt': (62, 64), 'task2-coffee/user_prompt.txt': (83, 87),
         'task2-coffee/revision_prompt.txt': (101, 103), 'task3-glitch/user_prompt.txt': (120, 126), 'task3-glitch/revision_prompt.txt': (141, 145)}
for rel, (a, b) in spans.items():
    want = '\n'.join(re.sub(r'^> ?', '', l) for l in lines[a - 1:b]) + '\n'
    check(open(f'{PACK}/{rel}', encoding='utf-8').read() == want, f'{rel} matches benchmark.md lines {a}-{b} verbatim')

# JSON validity
for rel in ['task1-dart/task_metadata.json', 'task2-coffee/task_metadata.json', 'task3-glitch/task_metadata.json',
            'task2-coffee/evaluator/manifest.json', 'task3-glitch/evaluator/manifest.json']:
    try:
        json.load(open(f'{PACK}/{rel}', encoding='utf-8'))
        check(True, f'{rel} is valid JSON')
    except Exception as e:  # noqa: BLE001
        check(False, f'{rel} invalid JSON: {e}')

# task1 assets: only the README line
check(sorted(os.listdir(f'{PACK}/task1-dart/assets')) == ['README.md'], 'task1-dart/assets contains only README.md')

# manifests: hashes, counts, footage limits
for task, aspect, (lo, hi), (w, h) in [('task2-coffee', '9:16', (14, 18), (1080, 1920)), ('task3-glitch', '16:9', (10, 13), (1920, 1080))]:
    m = json.load(open(f'{PACK}/{task}/evaluator/manifest.json', encoding='utf-8'))
    files = sorted(os.listdir(f'{PACK}/{task}/assets/footage'))
    check(lo <= len(files) <= hi, f'{task}: {len(files)} clips (allowed {lo}-{hi})')
    check(sorted(e['file'].split('/')[-1] for e in m['footage']) == files, f'{task}: manifest lists exactly the shipped footage')
    for e in m['footage']:
        p = f"{PACK}/{task}/{e['file']}"
        v, a, d = probe(p)
        name = e['file'].split('/')[-1]
        check(bool(re.fullmatch(r'clip\d\d_[a-z0-9_]+\.mp4', name)), f'{task}/{name}: name pattern clipNN_<slug>.mp4')
        check(sha(p) == e['sha256'], f'{task}/{name}: sha256 matches manifest')
        check((v['width'], v['height']) == (w, h), f"{task}/{name}: {v['width']}x{v['height']} ({aspect})")
        check(5.0 <= d <= 12.0, f'{task}/{name}: duration {d:.2f}s within 5-12 s')
        check(a is not None, f'{task}/{name}: has audio ({a["codec_name"] if a else "none"})')
        check(v['codec_name'] == 'hevc' and v.get('pix_fmt') == 'yuv420p10le', f"{task}/{name}: {v['codec_name']} {v.get('pix_fmt')}")
        check(e['retries'] <= 2, f"{task}/{name}: retries {e['retries']} <= 2")
    for e in m.get('other_assets', []) + m.get('ambience', []):
        p = f"{PACK}/{task}/{e['file']}"
        check(sha(p) == e['sha256'], f"{task}/{e['file']}: sha256 matches manifest")
    for e in m.get('ambience', []):
        p = f"{PACK}/{task}/{e['file']}"
        _, a, d = probe(p)
        check(10.0 <= d <= 20.0, f"{task}/{e['file']}: {d:.2f}s within 10-20 s, {a['codec_name']} {a['sample_rate']} Hz")
        check(abs(e['loudness_after']['integrated_lufs'] + 30) <= 0.5, f"{task}/{e['file']}: {e['loudness_after']['integrated_lufs']} LUFS (target -30)")
    check(os.path.exists(f'{PACK}/{task}/evaluator/overview.png'), f'{task}: evaluator/overview.png exists')

# Task 2 defects listed in metadata exist and match manifest intent
md = json.load(open(f'{PACK}/task2-coffee/task_metadata.json', encoding='utf-8'))
man = {e['file']: e for e in json.load(open(f'{PACK}/task2-coffee/evaluator/manifest.json', encoding='utf-8'))['footage']}
for d in md['defective_clips']:
    check(d['file'] in man and man[d['file']]['intended_defect'] == d['defect'], f"task2 metadata defect {d['file']} = {d['defect']} agrees with manifest")
check({e['intended_defect'] for e in man.values()} >= {'shaky', 'duplicate', 'overexposed', 'invalid'}, 'task2 has shaky, duplicate, overexposed and invalid clips')

# store profile facts agree with metadata
prof = open(f'{PACK}/task2-coffee/assets/store_profile.md', encoding='utf-8').read()
for item, price in md['facts_must_not_be_invented']['menu_prices_cny'].items():
    check(re.search(rf'\| {item} \| {price} \|', prof) is not None, f'store_profile.md lists {item} {price}')
check('2026 年 11 月 15 日' in prof and '周二至周日 8:00–18:00，周一店休' in prof, 'store_profile.md opening date and hours')

print(f'\n{len(fails)} failure(s)')
sys.exit(1 if fails else 0)
