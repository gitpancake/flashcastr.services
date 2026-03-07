FROM node:20-slim
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/api/ ./apps/api/

RUN npm ci --omit=dev

EXPOSE 4000 9094

CMD ["npx", "tsx", "apps/api/src/main.ts"]
