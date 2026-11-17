# syntax=docker/dockerfile:1

# ---- build: compile TypeScript, then drop dev dependencies ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: one image for the API, the click worker and the cleaner ----
FROM node:24-alpine
ENV NODE_ENV=production
# kafkajs triggers a harmless TimeoutNegativeWarning on Node >= 23; hide only that warning.
ENV NODE_OPTIONS=--disable-warning=TimeoutNegativeWarning
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000 9101
# Override per service: dist/workers/clickConsumer.js, dist/workers/expiredUrlCleaner.js, dist/db/migrate.js
CMD ["node", "dist/index.js"]
