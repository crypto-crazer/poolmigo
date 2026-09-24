# syntax=docker/dockerfile:1
#
# Multi-stage build for the Poolmigo keeper.
#   deps    -> full install (dev deps needed to compile TypeScript)
#   build   -> tsc
#   runtime -> production deps + dist only, running as a non-root user
#
# The build context is `backend/` alone: `src/abi/generated.ts` is committed precisely so the image
# does not need `../shared`. Regenerate it with `pnpm run sync-abis` when the contracts change.
#
# NEVER bake a key into this image. Pass KEEPER_KEY_FILE pointing at a mounted secret, or
# KEEPER_PRIVATE_KEY from a secret manager at runtime.

# ---------------------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@12.5.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# ---------------------------------------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only — no compiler, no test runner in the shipped image.
# `--prod` plus pnpm's peer handling keeps viem's *optional* `typescript` peer out of the runtime image.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

COPY --from=build /app/dist ./dist

# `node` (uid 1000) ships with the base image. The state directory must be writable by it.
RUN mkdir -p /var/lib/poolmigo-keeper && chown -R node:node /var/lib/poolmigo-keeper /app
USER node

# Safe defaults: dry-run, and state on a path meant to be a mounted volume.
ENV DRY_RUN=true \
    STATE_FILE=/var/lib/poolmigo-keeper/keeper-state.json \
    LOG_LEVEL=info

# `status` exits non-zero on preflight failure (wrong chain / not an authorised keeper).
HEALTHCHECK --interval=5m --timeout=30s --start-period=30s --retries=3 \
  CMD ["node", "dist/cli.js", "status"]

CMD ["node", "dist/cli.js", "run"]
