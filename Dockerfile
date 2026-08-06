# ── Stage 1: build CSS ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Fails the build when the hcs-schemas commit pinned in package-lock.json is
# older than this code needs. Placed here, in the builder, so a bad pin never
# reaches a published image: the box deploys from :latest. `npm ci` installs the
# pinned commit, so merging hcs-schemas alone does not update this repo - a step
# missed twice, both times publishing an image built against the wrong schema.
COPY scripts/check-schemas-version.js ./scripts/
RUN node scripts/check-schemas-version.js

COPY assets ./assets
COPY tailwind.config.js tailwind.safelist.js postcss.config.js ./
COPY mongoose/views ./mongoose/views
COPY mongoose/config ./mongoose/config
COPY scripts ./scripts
RUN npm run build:vendor && npm run build:css

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init curl tailscale

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY . .
COPY --from=builder /app/public/css/tailwind.css ./public/css/tailwind.css
COPY --from=builder /app/public/vendor ./public/vendor
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
