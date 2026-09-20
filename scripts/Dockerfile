FROM node:22-slim AS deps
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY scripts/ ./scripts/

RUN npm ci

FROM deps AS build

RUN npx esbuild scripts/promote-keep-set.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node22 \
  --external:pg \
  --outfile=/app/dist/promote-keep-set.js

RUN mkdir -p /app/runtime && node -e "require('fs').writeFileSync('/app/runtime/package.json', JSON.stringify({ private: true, dependencies: { pg: '^8.16.3' } }, null, 2))"
RUN npm install --omit=dev --prefix /app/runtime

FROM node:22-slim
WORKDIR /app

COPY --from=build /app/runtime/package.json ./package.json
COPY --from=build /app/runtime/node_modules ./node_modules
COPY --from=build /app/dist/promote-keep-set.js ./dist/promote-keep-set.js

CMD ["node", "dist/promote-keep-set.js"]
