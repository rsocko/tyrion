FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

RUN python -m venv /opt/venv
COPY monarch-bridge/requirements-runtime.txt .
RUN /opt/venv/bin/python -m pip install \
    --index-url https://pypi.org/simple \
    --require-hashes \
    --no-compile \
    -r requirements-runtime.txt

FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS runtime

ARG TYRION_UID=10001
ARG TYRION_GID=10001
ARG TYRION_REVISION=""

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8100 \
    BRIDGE_ALLOWED_ORIGINS=https://mc.socko.us \
    BRIDGE_REMOTE_TLS=true \
    BRIDGE_LOAD_DOTENV=false \
    DEFAULT_TRANSACTION_DAYS=90 \
    SESSION_FILE=/var/lib/tyrion/monarch-session.json

LABEL org.opencontainers.image.source="https://github.com/rsocko/tyrion" \
    org.opencontainers.image.revision="${TYRION_REVISION}" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.title="Tyrion Monarch Bridge" \
    org.opencontainers.image.description="Protected normalized Monarch connector for the Tyrion household-finance domain"

RUN groupadd --gid "${TYRION_GID}" tyrion \
    && useradd --uid "${TYRION_UID}" --gid tyrion --create-home \
        --home-dir /home/tyrion --shell /usr/sbin/nologin tyrion \
    && install -d -m 0700 -o tyrion -g tyrion /app /var/lib/tyrion

COPY --from=builder /opt/venv /opt/venv
COPY --chown=tyrion:tyrion LICENSE THIRD-PARTY-NOTICES.md /licenses/
COPY --chown=tyrion:tyrion monarch-bridge/bridge_runtime.py \
    monarch-bridge/contract.py \
    monarch-bridge/main.py \
    /app/

WORKDIR /app
VOLUME ["/var/lib/tyrion"]
USER tyrion

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/health', timeout=3).read()"]

CMD ["python", "main.py"]
