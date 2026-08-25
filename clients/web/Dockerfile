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

# Default command is the maker; compose overrides per service.
CMD ["npx", "tsx", "ops/mm.ts", "--help"]
