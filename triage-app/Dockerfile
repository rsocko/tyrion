FROM node:20.19.4-bookworm-slim@sha256:6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be8f25f70a AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

FROM base AS domain-builder
WORKDIR /workspace/kid-engine
COPY kid-engine/package.json kid-engine/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY kid-engine/tsconfig.json ./
COPY kid-engine/src ./src
RUN npm run build

FROM base AS dependencies
COPY --from=domain-builder /workspace/kid-engine/package.json /workspace/kid-engine/package.json
COPY --from=domain-builder /workspace/kid-engine/dist /workspace/kid-engine/dist
COPY --from=domain-builder /workspace/kid-engine/node_modules /workspace/kid-engine/node_modules
WORKDIR /workspace/triage-app
COPY triage-app/package.json triage-app/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
WORKDIR /workspace/triage-app
COPY --from=dependencies /workspace/kid-engine /workspace/kid-engine
COPY --from=dependencies /workspace/triage-app/node_modules ./node_modules
COPY triage-app .
RUN npm run build

FROM node:20.19.4-bookworm-slim@sha256:6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be8f25f70a AS runtime

ARG TYRION_UID=10001
ARG TYRION_GID=10001

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app
RUN groupadd --gid "${TYRION_GID}" tyrion \
    && useradd --uid "${TYRION_UID}" --gid tyrion --create-home \
        --home-dir /home/tyrion --shell /usr/sbin/nologin tyrion \
    && install -d -m 0700 -o tyrion -g tyrion /var/lib/tyrion-policy

COPY --chown=tyrion:tyrion LICENSE THIRD-PARTY-NOTICES.md /licenses/

COPY --from=builder --chown=tyrion:tyrion /workspace/triage-app/.next/standalone ./
COPY --from=builder --chown=tyrion:tyrion /workspace/triage-app/.next/static ./triage-app/.next/static

VOLUME ["/var/lib/tyrion-policy"]
WORKDIR /app/triage-app
USER tyrion
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "server.js"]
