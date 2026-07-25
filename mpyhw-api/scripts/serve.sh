#!/usr/bin/env bash
# Minimal FOREGROUND local API launcher (macOS/Linux mirror of serve.ps1). Loads
# mpyhw-api/.env into the process env, then runs uvicorn in the foreground (dies with the
# shell). No Postgres management: the server boots even without a reachable DB
# (db.initialize is guarded and the readiness probe gates real traffic), and /v1/web/events
# 204s regardless — enough to exercise the extension's welcome-page telemetry emit.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f "$ROOT/.env" ]; then
  echo "no .env found — create one first:  cp .env.example .env" >&2
  echo "(the .env.example DATABASE_URL is enough to boot; Postgres need not be running)" >&2
  exit 1
fi

# Export every KEY=value from .env into the process env (same intent as serve.ps1).
set -a
# shellcheck disable=SC1091
. "$ROOT/.env"
set +a

exec "$ROOT/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8080
