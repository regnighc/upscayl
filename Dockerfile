# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:18-bookworm-slim AS builder

# Skip downloading the Electron binary – we only need it as a TypeScript type
# source, not to run it.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run web:build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:18-bookworm-slim AS runtime

# Vulkan loader + Mesa ANV (Intel) driver + OpenMP runtime
# These are the only system libraries upscayl-bin needs on Intel iGPU.
# The ANV driver automatically picks up /dev/dri/renderD128 when present.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libvulkan1 \
        mesa-vulkan-drivers \
        libdrm2 \
        libdrm-intel1 \
        libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production Node deps only
COPY package*.json ./
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --omit=dev

# Compiled server + renderer static output
COPY --from=builder /app/export        ./export
COPY --from=builder /app/renderer/out  ./renderer/out

# upscayl-bin and AI models
COPY resources/linux/bin/upscayl-bin   ./resources/linux/bin/upscayl-bin
COPY resources/models                  ./resources/models

RUN chmod +x ./resources/linux/bin/upscayl-bin

EXPOSE 3000

CMD ["node", "export/server/index.js"]
