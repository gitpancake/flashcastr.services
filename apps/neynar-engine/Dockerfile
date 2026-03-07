FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/neynar-engine/ ./apps/neynar-engine/

RUN npm ci --omit=dev

EXPOSE 9090

CMD ["npx", "tsx", "apps/neynar-engine/src/main.ts"]
