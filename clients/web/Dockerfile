# Ops bot image: runs the TypeScript ops entry points (ops/mm.ts, ops/trader.ts,
# ops/check.ts) with tsx on the same engine source the web client ships.
# Build context: clients/web. See ops/README.md for the compose stack.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
COPY ops ./ops
COPY public ./public

RUN mkdir -p /app/ops/state /app/ops/logs

# Fly runs all three bots on one Machine. Compose overrides this command for
# its one-process-per-container services.
CMD ["/bin/bash", "ops/deploy/fly-entrypoint.sh"]
