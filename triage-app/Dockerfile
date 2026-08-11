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

FROM base AS finance-insights-builder
WORKDIR /workspace/finance-insights
COPY finance-insights/package.json finance-insights/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY finance-insights/tsconfig.json ./
COPY finance-insights/src ./src
RUN npm run build

FROM base AS dependencies
COPY --from=domain-builder /workspace/kid-engine/package.json /workspace/kid-engine/package.json
COPY --from=domain-builder /workspace/kid-engine/dist /workspace/kid-engine/dist
COPY --from=domain-builder /workspace/kid-engine/node_modules /workspace/kid-engine/node_modules
COPY --from=finance-insights-builder /workspace/finance-insights/package.json /workspace/finance-insights/package.json
COPY --from=finance-insights-builder /workspace/finance-insights/dist /workspace/finance-insights/dist
COPY --from=finance-insights-builder /workspace/finance-insights/node_modules /workspace/finance-insights/node_modules
WORKDIR /workspace/triage-app
COPY triage-app/package.json triage-app/package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
WORKDIR /workspace/triage-app
COPY --from=dependencies /workspace/kid-engine /workspace/kid-engine
COPY --from=dependencies /workspace/finance-insights /workspace/finance-insights
COPY --from=dependencies /workspace/triage-app/node_modules ./node_modules
COPY triage-app .
RUN npm run build
RUN set -eu; \
    mkdir -p /workspace/runtime-licenses; \
    sharp_count=0; \
    platform_count=0; \
    libvips_count=0; \
    for package_dir in node_modules/sharp node_modules/@img/*; do \
        [ -d "${package_dir}" ] || continue; \
        case "${package_dir}" in \
            node_modules/sharp) sharp_count=$((sharp_count + 1)) ;; \
            node_modules/@img/sharp-libvips-*) libvips_count=$((libvips_count + 1)) ;; \
            node_modules/@img/sharp-*) platform_count=$((platform_count + 1)) ;; \
        esac; \
        package_name="$(node -e "const p=require('./${package_dir}/package.json');process.stdout.write(p.name.replace(/^@/, '').replace('/', '--'))")"; \
        install -d "/workspace/runtime-licenses/${package_name}"; \
        license_count=0; \
        for license_file in "${package_dir}"/LICENSE* "${package_dir}"/COPYING* "${package_dir}"/NOTICE*; do \
            [ -f "${license_file}" ] || continue; \
            cp "${license_file}" "/workspace/runtime-licenses/${package_name}/"; \
            license_count=$((license_count + 1)); \
        done; \
        if [ "${license_count}" -eq 0 ] && [ "${package_dir#node_modules/@img/sharp-libvips-}" != "${package_dir}" ]; then \
            package_license="$(node -e "const p=require('./${package_dir}/package.json');process.stdout.write(p.license)")"; \
            [ "${package_license}" = "LGPL-3.0-or-later" ] || { echo "Unexpected libvips license for ${package_name}" >&2; exit 1; }; \
            cp /usr/share/common-licenses/LGPL-3 "/workspace/runtime-licenses/${package_name}/LICENSE"; \
            license_count=1; \
        fi; \
        [ "${license_count}" -gt 0 ] || { echo "Missing runtime license for ${package_name}" >&2; exit 1; }; \
    done; \
    [ "${sharp_count}" -eq 1 ] || { echo "Missing sharp runtime package" >&2; exit 1; }; \
    [ "${platform_count}" -gt 0 ] || { echo "Missing sharp platform runtime package" >&2; exit 1; }; \
    [ "${libvips_count}" -gt 0 ] || { echo "Missing libvips runtime package" >&2; exit 1; }

FROM node:20.19.4-bookworm-slim@sha256:6db5e436948af8f0244488a1f658c2c8e55a3ae51ca2e1686ed042be8f25f70a AS runtime

ARG TYRION_UID=10001
ARG TYRION_GID=10001
ARG TYRION_REVISION=""

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

LABEL org.opencontainers.image.source="https://github.com/rsocko/tyrion" \
    org.opencontainers.image.revision="${TYRION_REVISION}" \
    org.opencontainers.image.licenses="MIT" \
    org.opencontainers.image.title="Tyrion Operations UI" \
    org.opencontainers.image.description="Bounded operations and configuration UI for the Tyrion household-finance domain"

WORKDIR /app
RUN groupadd --gid "${TYRION_GID}" tyrion \
    && useradd --uid "${TYRION_UID}" --gid tyrion --create-home \
        --home-dir /home/tyrion --shell /usr/sbin/nologin tyrion \
    && install -d -m 0700 -o tyrion -g tyrion /var/lib/tyrion-policy \
    && install -d -m 0700 -o tyrion -g tyrion /var/lib/tyrion-finance-insights

COPY --chown=tyrion:tyrion LICENSE THIRD-PARTY-NOTICES.md /licenses/
COPY --from=builder --chown=tyrion:tyrion /workspace/runtime-licenses /licenses/npm-runtime

COPY --from=builder --chown=tyrion:tyrion /workspace/triage-app/.next/standalone ./
COPY --from=builder --chown=tyrion:tyrion /workspace/triage-app/.next/static ./triage-app/.next/static

VOLUME ["/var/lib/tyrion-policy", "/var/lib/tyrion-finance-insights"]
WORKDIR /app/triage-app
USER tyrion
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:3000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "server.js"]
