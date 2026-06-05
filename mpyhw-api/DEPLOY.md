# Deploying mpyhw-api to Fly.io

The backend ships as a container (`Dockerfile`) and runs on Fly.io with managed
Postgres. **All `docker build` / `fly deploy` commands run from the repo root**,
because the image needs the `third_party/MicroPython_Skills` submodule that lives
above this directory (see the comments in `Dockerfile` / `fly.toml`).

## One-time provisioning

```sh
# from the repo root
git submodule update --init --recursive        # image needs MicroPython_Skills

fly launch --no-deploy --config mpyhw-api/fly.toml --name blockless-api
fly postgres create --name blockless-db --region iad
fly postgres attach blockless-db --app blockless-api      # injects DATABASE_URL secret

fly secrets set --app blockless-api \
  MPYHW_JWT_SECRET="$(openssl rand -hex 32)" \
  DEEPSEEK_API_KEY="sk-..." \
  MPYHW_ADMIN_TOKEN="$(openssl rand -hex 24)"
# optional error tracking (no-op if unset):
# fly secrets set --app blockless-api SENTRY_DSN="https://...ingest.sentry.io/..."
```

`MPYHW_ENV=prod` is set in `fly.toml [env]`. Startup validation (`app/main.py`
`validate_config`) fails fast if any of the secrets above are missing or still at
their dev default, so a misconfigured deploy never serves traffic — it exits
non-zero and Fly rolls back.

## Deploy

```sh
# from the repo root
fly deploy --config mpyhw-api/fly.toml --dockerfile mpyhw-api/Dockerfile
```

CI deploys automatically on push to `main` after tests pass (see
`.github/workflows/ci.yml`, `deploy` job). It needs a repo secret `FLY_API_TOKEN`:

```sh
fly tokens create deploy -x 999999h    # paste into GitHub repo secret FLY_API_TOKEN
```

## Local image smoke test

```sh
# from the repo root
docker build -f mpyhw-api/Dockerfile -t mpyhw-api .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgresql://postgres:postgres@host.docker.internal:5432/mpyhw_test" \
  -e MPYHW_ENV=prod -e MPYHW_JWT_SECRET=x -e DEEPSEEK_API_KEY=y -e MPYHW_ADMIN_TOKEN=z \
  mpyhw-api
curl localhost:8080/v1/health           # {"status":"ok"}
curl localhost:8080/v1/health/ready      # {"status":"ok","db":"ok"} (200) when DB reachable
curl localhost:8080/v1/skills            # non-empty -> submodule copied at the right depth
curl localhost:8080/v1/boards            # non-empty -> content/ copied
```

## Render parity

The `Dockerfile` is host-agnostic (binds `0.0.0.0:$PORT`). On Render: a Docker
web service with **root directory = repo root** and **Dockerfile path =
`mpyhw-api/Dockerfile`**, a managed Postgres for `DATABASE_URL`, the same secrets
as env vars, and the health check path `/v1/health/ready`.

## Deferred decisions (deliberate, revisit when triggered)

- **Migrations.** Schema is created idempotently in `app/db.py`
  (`CREATE TABLE IF NOT EXISTS`, run at startup). This is safe for additive
  changes only — it will silently no-op on the first column/type change. When
  that first non-additive change appears, introduce Alembic: autogenerate the
  current schema as `0001_init`, then `alembic stamp` the live prod DB before
  applying anything new. Not before — no benefit yet.
- **Connection pooling.** `db.connect()` opens a fresh psycopg connection per
  request. Fine at the current global cap of 30 with `WEB_CONCURRENCY=2`. If
  `fly logs` show `too many clients` / connection-limit errors (e.g. after
  scaling workers or machines), add `psycopg_pool.ConnectionPool` inside
  `connect()` — the contextmanager signature stays identical, so no call site
  changes. Size so `workers * max_size * machines` stays under Postgres
  `max_connections` with headroom.
