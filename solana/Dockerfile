# Solana failover gateway - production container
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source (tsconfig + src). .env is NOT copied - injected at runtime.
COPY tsconfig.json ./
COPY src ./src

# Gateway listens on 4100 (server.ts reads PORT, defaults to 4100)
EXPOSE 4100

# Run the HTTP failover gateway
CMD ["npm", "run", "serve"]
