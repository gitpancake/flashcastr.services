FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/neynar-engine/ ./apps/neynar-engine/

RUN npm ci
RUN npx nx build neynar-engine

FROM node:20-slim
WORKDIR /app

COPY --from=builder /app/dist/apps/neynar-engine ./
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 9090

CMD ["node", "main.js"]
