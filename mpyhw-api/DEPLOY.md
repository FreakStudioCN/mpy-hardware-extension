# Deploying mpyhw-api to Render

The backend ships as a host-agnostic Docker image and is configured for Render
with the root `render.yaml` Blueprint. Render must build from the repo root,
because the image needs `third_party/MicroPython_Skills` in addition to
`mpyhw-api/`.

## Cost baseline

The default Blueprint uses Render's smallest paid production shape:

- Web Service `starter`
- Render Postgres `basic-256mb`

At the current Render pricing this is the low-cost production baseline. If SSE
LLM streams feel slow or memory-constrained, upgrade only the Web Service to
`standard` first; the database can stay `basic-256mb` until usage justifies more.

## One-time provisioning

1. Push this repo to GitHub with submodules available.
2. In Render, create a new Blueprint and point it at the repo root `render.yaml`.
3. When prompted for secret values, set:
   - `DEEPSEEK_API_KEY`
   - `MPYHW_ADMIN_TOKEN`
4. Let Render create:
   - Web Service `blockless-api`
   - Postgres `blockless-db`

The Blueprint injects `DATABASE_URL` from `blockless-db`, generates
`MPYHW_JWT_SECRET`, sets `MPYHW_ENV=prod`, and sets `WEB_CONCURRENCY=1` for the
starter instance size.

If you use Sentry, add `SENTRY_DSN` manually to the Render service environment
after creation. It is intentionally omitted from the Blueprint because it is
optional.

## Deploy

Use Render's Blueprint sync or service deploy button from the Dashboard. The
service should expose:

```text
https://blockless-api.onrender.com
```

Use `/v1/health/ready` as the readiness check. It validates database
connectivity, so Render does not route traffic to a process that cannot serve
stateful API requests.

## Local image smoke test

Run from the repo root:

```sh
docker build -f mpyhw-api/Dockerfile -t mpyhw-api .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/mpyhw_test" \
  -e MPYHW_ENV=prod -e MPYHW_JWT_SECRET=x -e DEEPSEEK_API_KEY=y -e MPYHW_ADMIN_TOKEN=z \
  mpyhw-api
curl localhost:8080/v1/health
curl localhost:8080/v1/health/ready
curl localhost:8080/v1/skills
curl localhost:8080/v1/boards
```

Expected results:

- `/v1/health` returns `{"status":"ok"}`.
- `/v1/health/ready` returns 200 with `{"status":"ok","db":"ok"}` when DB is reachable.
- `/v1/skills` is non-empty, proving the skills submodule was copied correctly.
- `/v1/boards` is non-empty, proving bundled content was copied correctly.

## CI and production URL

GitHub Actions still runs tests on pushes and PRs. Deployment is handled by
Render Blueprint sync rather than the old Fly deploy job. The published VS Code
extension defaults to:

```text
https://blockless-api.onrender.com
```

Developers can still override the backend with `mpyhw.apiBaseUrl` or
`MPYHW_API_BASE`.

## Deferred decisions

- **Migrations.** Schema is created idempotently in `app/db.py`
  (`CREATE TABLE IF NOT EXISTS`, run at startup). This is safe for additive
  changes only. When the first non-additive change appears, introduce Alembic:
  autogenerate the current schema as `0001_init`, then stamp the live prod DB
  before applying new migrations.
- **Connection pooling.** `db.connect()` opens a fresh psycopg connection per
  request. This is acceptable at the current concurrency limits. If Render logs
  show `too many clients` or connection-limit errors after scaling workers or
  instances, add `psycopg_pool.ConnectionPool` behind the existing `connect()`
  context manager.
