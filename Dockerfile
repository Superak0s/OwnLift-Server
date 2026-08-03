# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:24-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist

RUN mkdir -p uploads
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:5000/', r => process.exit(r.statusCode < 500 ? 0 : 1))"
CMD ["node", "dist/server.js"]