# On-screen text for the judges: RapidOCR on each image given, one JSON line per image.
# Run with the TimelineBench venv: <tlb>/venv/bin/python -I ocr.py frame1.png frame2.png ...
import json
import sys

from rapidocr_onnxruntime import RapidOCR

ocr = RapidOCR()
for path in sys.argv[1:]:
    result, _ = ocr(path)
    lines = []
    for box, text, conf in result or []:
        if float(conf) >= 0.6 and len(text.strip()) >= 2:
            ys = [p[1] for p in box]
            lines.append({"text": text.strip(), "conf": round(float(conf), 3), "y": round(sum(ys) / len(ys))})
    lines.sort(key=lambda x: x["y"])
    print(json.dumps({"file": path, "lines": lines}, ensure_ascii=False), flush=True)
