FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/flash-engine/ ./apps/flash-engine/

RUN npm ci --omit=dev

EXPOSE 9090

CMD ["npx", "tsx", "apps/flash-engine/src/main.ts"]
