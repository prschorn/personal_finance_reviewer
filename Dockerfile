# syntax=docker/dockerfile:1

# better-sqlite3 is a native module, so node_modules is built inside the image
# rather than copied from the host (which holds darwin/arm64 binaries).

# ---- deps: production dependencies only -------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# This base image is glibc, so the musl/wasm variants of the native optional
# dependencies can never load. Pruning them in the same layer saves ~160 MB.
RUN npm ci --omit=dev \
 && rm -rf node_modules/@next/swc-*-musl \
           node_modules/@img/sharp-libvips-linuxmusl-* \
           node_modules/@img/sharp-linuxmusl-* \
           node_modules/@img/sharp-wasm32

# ---- build: full dependencies + next build ----------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# `next start` loads next.config.* at boot. A .ts config would make it shell out
# to install TypeScript inside the container, so emit a plain ESM config here,
# where the TypeScript toolchain already exists.
RUN npx tsc next.config.ts --outDir /tmp/nextcfg \
        --module es2022 --target es2022 --moduleResolution bundler --skipLibCheck \
 && mv /tmp/nextcfg/next.config.js /tmp/nextcfg/next.config.mjs

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    FINANCE_DB_PATH=/data/finance.db

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/.next        ./.next
COPY package.json ./
COPY --from=build /tmp/nextcfg/next.config.mjs ./next.config.mjs
COPY drizzle ./drizzle

# A snapshot of the SQLite database travels inside the image. The entrypoint
# restores it into the /data volume the first time the container starts, so the
# data survives rebuilds from then on.
COPY db ./seed-db

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /data \
 && chown -R node:node /data /app/seed-db

USER node
EXPOSE 3000
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["./node_modules/.bin/next", "start"]
