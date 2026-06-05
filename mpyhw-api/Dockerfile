# Production image for mpyhw-api.
#
# IMPORTANT: build from the REPO ROOT, not mpyhw-api/ —
#   docker build -f mpyhw-api/Dockerfile -t mpyhw-api .
# The app resolves the skills submodule via parents[2] of app/skill_catalog.py
# (the repo root) and content/ via parents[1] of app/. The COPY layout below
# reproduces that geometry inside the image (/app/app, /app/content,
# /third_party/MicroPython_Skills) so those path lookups still resolve.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    PORT=8080

WORKDIR /app

# Install deps first so the layer caches independently of source changes.
# psycopg[binary] ships its own libpq wheel — no apt build deps needed.
COPY mpyhw-api/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Copy preserving the path geometry the code expects (see header note).
COPY mpyhw-api/app /app/app
COPY mpyhw-api/content /app/content
COPY mpyhw-api/pyproject.toml /app/pyproject.toml
COPY third_party/MicroPython_Skills /third_party/MicroPython_Skills

# Drop privileges. Code is read-only at runtime (state lives in Postgres).
RUN useradd --create-home --uid 10001 app
USER app

# Liveness probe for `docker run`; Fly uses its own HTTP check (see fly.toml).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8080')+'/v1/health')" || exit 1

# Shell form so ${PORT}/${WEB_CONCURRENCY} expand; exec so uvicorn gets PID 1 signals.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers ${WEB_CONCURRENCY:-2}"]
