FROM node:20.19.4-bookworm-slim@sha256:6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be8f25f70a AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runtime

ARG TYRION_UID=10001
ARG TYRION_GID=10001

ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --gid "${TYRION_GID}" tyrion \
    && useradd --uid "${TYRION_UID}" --gid tyrion --create-home \
        --home-dir /home/tyrion --shell /usr/sbin/nologin tyrion

COPY --from=builder --chown=tyrion:tyrion /app/.next/standalone ./
COPY --from=builder --chown=tyrion:tyrion /app/.next/static ./.next/static

USER tyrion
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "server.js"]
