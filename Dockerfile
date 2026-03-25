# ============================================================
# Stage 1: Build client + prepare module for publishing
# ============================================================
FROM node:20-slim AS builder

# Install SpacetimeDB CLI
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://install.spacetimedb.com | sh -s -- --yes
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY spacetimedb/package.json spacetimedb/
RUN npm ci

# Copy source
COPY spacetimedb/ spacetimedb/
COPY src/ src/
COPY index.html tsconfig.json vite.config.ts ./

# Generate client bindings (compiles module locally, no server needed)
RUN spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb

# Build client (Vite) — WS URL auto-detected from page location at runtime
RUN npm run build

# ============================================================
# Stage 2: Publisher — used by init service to publish module
# ============================================================
FROM node:20-slim AS publisher

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://install.spacetimedb.com | sh -s -- --yes
ENV PATH="/root/.local/bin:$PATH"

WORKDIR /app
COPY package.json package-lock.json ./
COPY spacetimedb/ spacetimedb/
RUN cd spacetimedb && npm install --ignore-scripts 2>/dev/null; true

COPY docker/publish.sh /publish.sh
RUN chmod +x /publish.sh

CMD ["/publish.sh"]

# ============================================================
# Stage 3: Client — nginx serving static files
# ============================================================
FROM nginx:alpine AS client

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
