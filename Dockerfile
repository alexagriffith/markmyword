# markmyword — single always-on Node box (Express + better-sqlite3).
# better-sqlite3 is a native addon, so the build stage needs a toolchain; the
# final image carries only the built node_modules + app.
FROM node:22-slim AS build
WORKDIR /app
# Build deps for better-sqlite3 (node-gyp: python3 + make + g++).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Data (SQLite + uploaded docs) lives on a mounted volume at /data.
ENV HS_DB_PATH=/data/app.db
ENV HS_DOCS_DIR=/data/docs
ENV PORT=8080
COPY --from=build /app /app
EXPOSE 8080
CMD ["node", "server.js"]
