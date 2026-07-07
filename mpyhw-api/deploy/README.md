# Deploying mpyhw-api behind Caddy (server migration)

Everything the ops owner needs to run the **plugin / VS Code extension backend** as a container
behind an existing Caddy reverse proxy  -  no host-level code, no `:80/:443` grab. This is the
Caddy-based counterpart to [DEPLOY.md](../DEPLOY.md) (which covers the Render Blueprint).

## What's here

| File | Purpose |
|------|---------|
| `compose.yml` | Runs the API (built from `mpyhw-api/Dockerfile`) + a bundled Postgres, on an internal network only. |
| `.env.example` | Every environment variable, marked REQUIRED / OPTIONAL. Copy to `.env` and fill in. |
| `Caddyfile.snippet` | The `reverse_proxy` block to add to your Caddyfile. |

The image is defined by [`../Dockerfile`](../Dockerfile): Python 3.12-slim, non-root, healthcheck
on `/v1/health`, listens on `8080`.

## Getting the image (pick one)

- **Pull the prebuilt image (default).** Our CI (`.github/workflows/publish-image.yml`) builds and
  pushes it to GHCR on every push to main: `ghcr.io/freakstudiocn/mpyhw-api:latest` (v* tags also get
  `:<version>`). `compose.yml` already points at it, so no repo/source on the server - just:
  ```sh
  docker compose -f mpyhw-api/deploy/compose.yml --env-file mpyhw-api/deploy/.env up -d
  ```
- **Build from source (alternative).** If you'd rather build:
  ```sh
  git submodule update --init --recursive     # image needs third_party/MicroPython_Skills + contracts/
  # in compose.yml: comment out `image:`, uncomment the `build:` block, then:
  docker compose -f mpyhw-api/deploy/compose.yml --env-file mpyhw-api/deploy/.env up -d --build
  ```
  Builds from the repo root; raw code never runs on the host - it's compiled into an image first.

> **GHCR package visibility (one-time):** the first CI publish creates the package as *private*. A
> repo/org admin must set `ghcr.io/freakstudiocn/mpyhw-api` to **public** (GitHub -> Packages -> the
> package -> Package settings -> Change visibility) so the server can pull without credentials.
> Alternatively keep it private and `docker login ghcr.io` on the server with a `read:packages` token.

## Networking / Caddy

- The API is **not** published to the host  -  only on the shared Docker network, reached by Caddy
  as `api:8080`. Set the real Caddy network name under `networks: edge:` in `compose.yml`.
- Add the `Caddyfile.snippet` block at the hostname the backend should live at (`api.block-less.com`).

## Secrets we (Blockless side) still owe you

Not in the repo  -  provide out-of-band (not pasted into the chat group):

1. `DEEPSEEK_API_KEY`  -  a **fresh** DeepSeek key (the previous one is dead).
2. `MPYHW_GITHUB_CLIENT_ID` / `MPYHW_GITHUB_CLIENT_SECRET`  -  the extension's GitHub sign-in.
3. `MPYHW_JWT_SECRET`, `MPYHW_ADMIN_TOKEN`, `POSTGRES_PASSWORD`  -  random (`openssl rand -hex 32`).

## GitHub OAuth callback  -  must be updated for the new host

Login builds its callback from `MPYHW_PUBLIC_API_BASE`. After migration set it to
`https://api.block-less.com`, and register this exact callback in the GitHub OAuth app
(github.com -> Settings -> Developer settings -> OAuth Apps):

```
https://api.block-less.com/v1/auth/github/callback
```

If this isn't updated, sign-in breaks after the move even though the API is up.

## Database

`compose.yml` bundles Postgres with a named volume  -  a clean, fresh start (app builds its own
schema on boot). You set the DB password once (`POSTGRES_PASSWORD` in `.env`); compose assembles
`DATABASE_URL` from it. For a managed Postgres, delete the `db:` service and set `DATABASE_URL`
directly in `compose.yml`'s `environment:` to your instance.

## Verify it's up

```
curl -s https://api.block-less.com/v1/health         # -> {"status":"ok"}
curl -s https://api.block-less.com/v1/health/ready    # -> {"status":"ok","db":"ok"}
curl -s https://api.block-less.com/v1/skills          # -> non-empty (skills submodule copied)
curl -s https://api.block-less.com/v1/boards          # -> non-empty (bundled content copied)
```
