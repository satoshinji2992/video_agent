#!/usr/bin/env python3
"""Objective checks for generated clips.

shake <clip...>        per-frame global motion (phase correlation, in 1080p pixels): mean |motion| per frame
                       and jitter (std of motion minus its 0.5 s moving average). Higher = shakier.
lock <plate> <clip...> camera drift of each clip against the plate still: offset (px) and mean abs pixel
                       difference of the first and last frames versus the plate, at 480 px width.
"""
import sys, json
import cv2
import numpy as np


def frames(path, width):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    out = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        h, w = f.shape[:2]
        scale = width / w
        out.append(cv2.cvtColor(cv2.resize(f, (width, int(h * scale))), cv2.COLOR_BGR2GRAY).astype(np.float32))
    return out, fps


def shake(path):
    fs, fps = frames(path, 360)
    w = fs[0].shape[1]
    win = cv2.createHanningWindow(fs[0].shape[::-1], cv2.CV_32F)
    d = []
    for a, b in zip(fs, fs[1:]):
        (dx, dy), _ = cv2.phaseCorrelate(a.copy(), b.copy(), win)
        d.append((dx, dy))
    d = np.array(d) * (1080 / w if fs[0].shape[1] < fs[0].shape[0] else 1920 / w)
    mag = np.hypot(d[:, 0], d[:, 1])
    k = max(3, int(fps / 2))
    kernel = np.ones(k) / k
    smooth = np.stack([np.convolve(d[:, i], kernel, mode='same') for i in range(2)], 1)
    jitter = np.hypot(*(d - smooth).T)
    return {'clip': path.split('/')[-2] + '/' + path.split('/')[-1], 'mean_px_per_frame': round(float(mag.mean()), 2),
            'p90_px_per_frame': round(float(np.percentile(mag, 90)), 2), 'jitter_px': round(float(jitter.mean()), 2)}


def lock(plate, path):
    p = cv2.imread(plate)
    fs, _ = frames(path, 480)
    pg = cv2.cvtColor(cv2.resize(p, (480, int(p.shape[0] * 480 / p.shape[1]))), cv2.COLOR_BGR2GRAY).astype(np.float32)
    win = cv2.createHanningWindow(pg.shape[::-1], cv2.CV_32F)
    res = {}
    for name, f in (('first', fs[0]), ('mid', fs[len(fs) // 2]), ('last', fs[-1])):
        if f.shape != pg.shape:
            f = cv2.resize(f, pg.shape[::-1])
        mad = float(np.abs(pg - f).mean())
        (dx, dy), _ = cv2.phaseCorrelate(pg.copy(), f.copy(), win)
        res[name] = {'offset_px_1080p': round(float(np.hypot(dx, dy) * 1920 / 480), 1), 'mad': round(mad, 1)}
    return {'clip': path.split('/')[-2] + '/' + path.split('/')[-1], **res}


if __name__ == '__main__':
    cmd, *args = sys.argv[1:]
    if cmd == 'shake':
        for a in args:
            print(json.dumps(shake(a), ensure_ascii=False))
    elif cmd == 'lock':
        for a in args[1:]:
            print(json.dumps(lock(args[0], a), ensure_ascii=False))


def glitch(path, seconds=2.0):
    """Per-frame Laplacian energy (texture) over the first `seconds`, relative to the median of frames 1–2 s."""
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    vals = []
    while len(vals) < int(seconds * fps):
        ok, f = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(f, (f.shape[1] // 4, f.shape[0] // 4)), cv2.COLOR_BGR2GRAY)
        vals.append(float(cv2.Laplacian(g, cv2.CV_64F).var()))
    base = float(np.median(vals[int(fps):])) or 1.0
    rel = [v / base for v in vals]
    worst = int(np.argmax(rel))
    return {'clip': path.split('/')[-2] + '/' + path.split('/')[-1], 'max_rel': round(max(rel), 2), 'at_s': round(worst / fps, 2),
            'first_s': [round(r, 2) for r in rel[: int(fps)][::3]]}


if __name__ == '__main__' and sys.argv[1] == 'glitch':
    for a in sys.argv[2:]:
        print(json.dumps(glitch(a), ensure_ascii=False))
