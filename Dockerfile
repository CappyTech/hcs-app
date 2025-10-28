# syntax=docker/dockerfile:1

# Use a slim Node LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /mnt/data/hcs/app

# Install OS deps if needed (bash, openssl), keep minimal
RUN apk add --no-cache dumb-init curl

# Copy package manifests first for better caching
COPY package*.json ./

# Install dependencies (no dev deps in production build by default)
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
# Prefer ci when a lockfile is present; fall back to install otherwise
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
			npm ci --omit=dev; \
		else \
			npm install --omit=dev; \
		fi

# Copy app source
COPY . .

# Build step (if any). Currently none.

# Expose app port
ENV PORT=5000
EXPOSE 5000

# Non-root user for security (optional)
# RUN addgroup -S app && adduser -S app -G app
# USER app

# Use dumb-init for proper PID 1 signal handling
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the server
CMD ["node", "app.js"]
