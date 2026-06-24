# ── Stage 1: build CSS ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY assets ./assets
COPY tailwind.config.js postcss.config.js ./
COPY mongoose/views ./mongoose/views
COPY mongoose/config ./mongoose/config
COPY scripts ./scripts
RUN npm run build:css

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init curl tailscale

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY . .
COPY --from=builder /app/public/css/tailwind.css ./public/css/tailwind.css
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=5000

# Short commit SHA, surfaced in the app footer. Pass at build time:
#   docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) ...
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 5000

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "app.js"]
