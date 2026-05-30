FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/agent-flashcastr/ ./apps/agent-flashcastr/

RUN npm ci --omit=dev

# 9090 = Prometheus metrics; PORT = Neynar inbound webhook receiver (Railway public domain)
EXPOSE 9090

CMD ["npx", "tsx", "apps/agent-flashcastr/src/main.ts"]
