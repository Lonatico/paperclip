# syntax=docker/dockerfile:1.20
#
# Production image for Paperclip (API + static UI). Tested layout for Railway:
#
# 1. Provision PostgreSQL on Railway and set DATABASE_URL on the same service
#    (or point DATABASE_URL to any external Postgres).
# 2. Railway sets PORT at runtime — do not hardcode PORT in the image; the server
#    reads process.env.PORT (see server/src/config.ts).
# 3. For OAuth / magic links in authenticated mode, set the public URL env vars
#    documented in doc/DEVELOPING.md / deployment docs (e.g. PAPERCLIP_API_URL,
#    BETTER_AUTH_URL or your auth base URL as required by your setup).
# 4. Private exposure: default Railway URL host (*.up.railway.app) is auto-allowed when
#    Railway injects RAILWAY_* env. Custom domains still need PAPERCLIP_ALLOWED_HOSTNAMES.
#    Deploy probe Host healthcheck.railway.app is allowlisted in code.
# 5. Authenticated mode (below): set BETTER_AUTH_SECRET in Railway Variables (e.g.
#    openssl rand -hex 32). Optional alternative: PAPERCLIP_AGENT_JWT_SECRET. Never
#    bake secrets into the image.
# 6. Cursor CLI (cursor_local adapter): build-arg INSTALL_CURSOR_AGENT=1 (default) installs
#    under /opt/cursor-agent/.local/bin — not under /paperclip — so a Railway Volume mounted
#    at /paperclip does not hide the CLI. Symlink: /usr/local/bin/agent. Set CURSOR_API_KEY
#    on the service (not in the image).
#
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY patches/ patches/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
# Set to 1 so Paperclip cursor_local can resolve `agent` / `cursor-agent` (see header §6).
ARG INSTALL_CURSOR_AGENT=1
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

RUN if [ "$INSTALL_CURSOR_AGENT" = "1" ]; then \
  install_home=/opt/cursor-agent \
  && mkdir -p "$install_home/.local/bin" \
  && chown -R node:node "$install_home" \
  && gosu node bash -lc 'set -euo pipefail; export HOME=/opt/cursor-agent; curl -fsS https://cursor.com/install | bash' \
  && gosu node bash -lc 'set -euo pipefail; export HOME=/opt/cursor-agent; export PATH="$HOME/.local/bin:$PATH"; \
    if command -v agent >/dev/null 2>&1; then agent --version; \
    elif command -v cursor-agent >/dev/null 2>&1; then cursor-agent --version; \
    elif [ -x "$HOME/.local/bin/agent" ]; then "$HOME/.local/bin/agent" --version; \
    elif [ -x "$HOME/.local/bin/cursor-agent" ]; then "$HOME/.local/bin/cursor-agent" --version; \
    else echo "Cursor install did not provide agent or cursor-agent under /opt/cursor-agent/.local/bin" >&2; ls -la "$HOME/.local/bin" >&2; exit 1; fi' \
  && gosu node bash -lc 'export HOME=/opt/cursor-agent; if [ -x "$HOME/.local/bin/cursor-agent" ] && ! [ -x "$HOME/.local/bin/agent" ] && ! [ -L "$HOME/.local/bin/agent" ]; then ln -sf "$HOME/.local/bin/cursor-agent" "$HOME/.local/bin/agent"; fi' \
  && if [ -x /opt/cursor-agent/.local/bin/agent ]; then ln -sf /opt/cursor-agent/.local/bin/agent /usr/local/bin/agent; \
  elif [ -x /opt/cursor-agent/.local/bin/cursor-agent ]; then ln -sf /opt/cursor-agent/.local/bin/cursor-agent /usr/local/bin/agent; fi; \
  fi

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PATH=/opt/cursor-agent/.local/bin:${PATH} \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  OPENCODE_ALLOW_ALL_MODELS=true

# No VOLUME: Railway rejects Dockerfile VOLUME; attach a Railway Volume and mount
# at /paperclip in the service settings if you need persistent HOME/config there.
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
