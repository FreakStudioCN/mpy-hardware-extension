"""Read-only diagnostic query against whatever DATABASE_URL .env points to.
Lists recent sessions + telemetry recency. No writes."""
import sys
from pathlib import Path

ENV_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".env")
KEY = sys.argv[2] if len(sys.argv) > 2 else "DATABASE_URL"
env = {}
for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip()

url = env.get(KEY)
if not url:
    print(f"NO {KEY} in env"); sys.exit(0)

import psycopg
from psycopg.rows import dict_row

try:
    conn = psycopg.connect(url, row_factory=dict_row, connect_timeout=5)
except Exception as e:
    print("CONNECT_FAILED:", type(e).__name__, str(e)[:300]); sys.exit(0)

with conn:
    try:
        n = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
        last = conn.execute("SELECT MAX(created_at) AS last FROM telemetry_events").fetchone()["last"]
        tot = conn.execute("SELECT COUNT(*) AS n FROM telemetry_events").fetchone()["n"]
        print(f"=== DB reachable. sessions={n}  telemetry_events={tot}  last_event_created_at={last}")
        rows = conn.execute(
            "SELECT trace_id, board_id, started_at, ended_at, terminal, turn_count, repair_count "
            "FROM sessions ORDER BY started_at DESC LIMIT 15"
        ).fetchall()
        print(f"=== {len(rows)} most recent sessions ===")
        for r in rows:
            print(f"{str(r['started_at'])[:19]}  term={r['terminal']}  turns={r['turn_count']}  rep={r['repair_count']}  board={r['board_id']}  trace={r['trace_id']}")
    except Exception as e:
        print("QUERY_FAILED:", type(e).__name__, str(e)[:300])
