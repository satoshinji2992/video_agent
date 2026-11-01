# Runs TimelineBench's six content guards on each video given, one JSON line per video.
import json, sys
from timelinebench.verify.guards import run_guards
for path in sys.argv[1:]:
    r = run_guards(path)
    vals = {k: (round(v, 3) if isinstance(v, (int, float)) else v) for k, v in r.get("values", {}).items()}
    print(json.dumps({"video": path.split("/sessions/")[-1][-60:], "passed": r["passed"], "failed": r["failed"], "unmeasured": r["unmeasured"], "values": vals}, ensure_ascii=False), flush=True)
