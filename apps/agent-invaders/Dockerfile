FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/agent-invaders/ ./apps/agent-invaders/

RUN npm ci --omit=dev

EXPOSE 8080

CMD ["npx", "tsx", "apps/agent-invaders/src/main.ts"]
