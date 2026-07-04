"""Read-only: dump the ordered telemetry event stream (+ llm_turns) for given trace_ids."""
import sys, json
from pathlib import Path

ENV_PATH = Path(sys.argv[1]); KEY = sys.argv[2]; TRACES = sys.argv[3:]
env = {}
for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line: continue
    k, v = line.split("=", 1); env[k.strip()] = v.strip()
url = env[KEY]

import psycopg
from psycopg.rows import dict_row
conn = psycopg.connect(url, row_factory=dict_row, connect_timeout=10)

INTEREST = ["phase","action","status","success","error_kind","error","tool","name","script",
            "op","terminal","message","kind","reason","approval_id","next_phase","result",
            "count","stage","step","title","detail","label","text"]

with conn:
    for t in TRACES:
        rows = conn.execute(
            "SELECT event_type, payload_json, timestamp FROM telemetry_events WHERE trace_id=%s ORDER BY id",
            (t,)).fetchall()
        print(f"\n===== {t}  ({len(rows)} events) =====")
        for r in rows:
            p = r["payload_json"]
            if isinstance(p, str):
                try: p = json.loads(p)
                except Exception: p = {}
            p = p if isinstance(p, dict) else {"_": p}
            summ = {k: p[k] for k in INTEREST if k in p}
            s = json.dumps(summ, ensure_ascii=False, default=str) if summ else json.dumps(p, ensure_ascii=False, default=str)[:200]
            print(f"  {str(r['timestamp'])[11:19]}  {r['event_type']:<22} {s}")
        turns = conn.execute(
            "SELECT kind, model, status, error_kind, duration_ms, total_tokens, started_at, ended_at "
            "FROM llm_turns WHERE trace_id=%s ORDER BY id", (t,)).fetchall()
        if turns:
            print(f"  --- llm_turns ({len(turns)}) ---")
            for tn in turns:
                print(f"    {str(tn['started_at'])[11:19]}  kind={tn['kind']} status={tn['status']} err={tn['error_kind']} dur={tn['duration_ms']}ms tok={tn['total_tokens']} model={tn['model']}")
