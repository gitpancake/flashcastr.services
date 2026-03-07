FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/database-engine/ ./apps/database-engine/

RUN npm ci --omit=dev

EXPOSE 9090

CMD ["npx", "tsx", "apps/database-engine/src/main.ts"]
