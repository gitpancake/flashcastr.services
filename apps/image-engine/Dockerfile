FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/image-engine/ ./apps/image-engine/

RUN npm ci --omit=dev

EXPOSE 9090

CMD ["npx", "tsx", "--expose-gc", "apps/image-engine/src/main.ts"]
