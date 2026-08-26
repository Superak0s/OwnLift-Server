# ─── Build stage ─────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm prune --prod

# ─── Production stage ────────────────────────────────────────────────────────
FROM node:24-alpine AS production

RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p public
RUN printf '#!/bin/sh\nexec node /app/dist/ownlift.js "$@"\n' > /usr/local/bin/ownlift && chmod +x /usr/local/bin/ownlift
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 5000
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "require('http').get('http://localhost:5000/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--env-file-if-exists=.env", "dist/server.js"]