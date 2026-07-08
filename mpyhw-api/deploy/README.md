# Deploying mpyhw-api behind Caddy (server migration)

Everything the ops owner needs to run the **plugin / VS Code extension backend** as a container
behind an existing Caddy reverse proxy  -  no host-level code, no `:80/:443` grab. This is the
Caddy-based counterpart to [DEPLOY.md](../DEPLOY.md) (which covers the Render Blueprint).

## What's here

| File | Purpose |
|------|---------|
| `compose.yml` | **Self-contained** stack: the API image (pulled from GHCR) + a bundled Postgres, all env inline. No separate `.env`. |
| `Caddyfile.snippet` | The `reverse_proxy` block to add to your Caddyfile. |

The image is defined by [`../Dockerfile`](../Dockerfile): Python 3.12-slim, non-root, healthcheck
on `/v1/health`, listens on `8080`. Served publicly at **`https://blockless.upypi.net`**.

## Run it

Everything is in `compose.yml`. Fill every `CHANGE-ME` in it first (see below), then:

```sh
docker compose -f compose.yml up -d
```

The image is pulled from GHCR (`ghcr.io/freakstudiocn/mpyhw-api:latest`). Make that package
**public** once (GitHub -> Packages -> `mpyhw-api` -> Package settings -> Change visibility), or
`docker login ghcr.io` on the server with a `read:packages` token.

## Values to fill in `compose.yml`

| Variable | How to get it |
|----------|---------------|
| `POSTGRES_PASSWORD` + the password inside `DATABASE_URL` (keep identical) | `openssl rand -hex 16` |
| `MPYHW_JWT_SECRET` | `openssl rand -hex 32` |
| `MPYHW_ADMIN_TOKEN` | `openssl rand -hex 24` |
| `DEEPSEEK_API_KEY` | the DeepSeek `sk-...` key (Blockless side provides) |
| `MPYHW_GITHUB_CLIENT_ID` / `MPYHW_GITHUB_CLIENT_SECRET` | the GitHub OAuth app (Blockless side provides; needed for user login - the backend still **starts** without them) |

These are secrets: send the filled `compose.yml` **privately**, never commit it to a public repo.

## Networking / Caddy

- The API is **not** published to the host  -  only on the shared Docker network, reached by Caddy
  as `mpyhw-api:8080`. Set the real Caddy network name under `networks: edge:` in `compose.yml`.
- Add the `Caddyfile.snippet` block for `blockless.upypi.net`. DNS for that subdomain is on
  `upypi.net` (the ops owner's domain), so the ops owner points it at this server - nothing to do
  on the `block-less.com` / Cloudflare side.

## GitHub OAuth callback  -  must match the host

Login builds its callback from `MPYHW_PUBLIC_API_BASE` (`https://blockless.upypi.net`). Register
this exact callback in the GitHub OAuth app (github.com -> Settings -> Developer settings -> OAuth Apps):

```
https://blockless.upypi.net/v1/auth/github/callback
```

If this isn't set, sign-in breaks even though the API is up.

## Database

`compose.yml` bundles Postgres with a named volume  -  a clean, fresh start (app builds its own
schema on boot; no Render data migrates). For a managed Postgres, delete the `db:` service and point
`DATABASE_URL` at your instance.

## Verify it's up

```
curl -s https://blockless.upypi.net/v1/health         # -> {"status":"ok"}
curl -s https://blockless.upypi.net/v1/health/ready    # -> {"status":"ok","db":"ok"}
curl -s https://blockless.upypi.net/v1/skills          # -> non-empty (skills submodule copied)
curl -s https://blockless.upypi.net/v1/boards          # -> non-empty (bundled content copied)
```
