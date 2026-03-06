# ── electron-build ─────────────────────────────────────────
FROM electronuserland/builder:22-wine AS electron-builder
WORKDIR /workspace
COPY package.json ./
RUN npm install
COPY . .
# Build Windows and Linux apps
RUN npm run build:win && npm run build:linux

# ── docs-deps ──────────────────────────────────────────────
FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY docs/package.json ./
RUN npm install --ignore-scripts

# ── docs-build ─────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY docs/ .

# Extract built desktop apps
RUN mkdir -p public/downloads
COPY --from=electron-builder /workspace/dist/ /tmp/dist/
RUN find /tmp/dist -name "*.exe" -exec cp {} public/downloads/OpenCowork-Windows-Setup.exe \; || true
RUN find /tmp/dist -name "*.AppImage" -exec cp {} public/downloads/OpenCowork.AppImage \; || true
RUN find /tmp/dist -name "*.deb" -exec cp {} public/downloads/OpenCowork.deb \; || true

RUN npm rebuild esbuild lightningcss
RUN npm run postinstall
RUN npm run build

# ── runner ────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
