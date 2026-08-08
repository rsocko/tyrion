# syntax=docker/dockerfile:1.7

FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8100 \
    BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us \
    BRIDGE_REMOTE_TLS=true \
    BRIDGE_LOAD_DOTENV=false \
    DEFAULT_TRANSACTION_DAYS=90 \
    SESSION_FILE=/var/lib/tyrion/monarch-session.json

WORKDIR /app

RUN groupadd --gid 10001 tyrion \
    && useradd --uid 10001 --gid tyrion --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin tyrion \
    && install --directory --mode 0700 --owner tyrion --group tyrion /var/lib/tyrion

COPY requirements-runtime.txt ./
RUN python -m pip install --no-compile --requirement requirements-runtime.txt

COPY --chown=tyrion:tyrion bridge_runtime.py contract.py main.py ./

USER 10001:10001

EXPOSE 8100
VOLUME ["/var/lib/tyrion"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=3); raise SystemExit(0 if response.status == 200 else 1)"]

CMD ["python", "main.py"]
