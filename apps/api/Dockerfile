FROM node:22-slim AS deps
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY libs/ ./libs/
COPY apps/api/ ./apps/api/

RUN npm ci

FROM deps AS build

RUN npx esbuild apps/api/src/main.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" \
  --external:pg \
  --external:@neynar/nodejs-sdk \
  --outfile=/app/dist/main.js

RUN mkdir -p /app/runtime && node -e "require('fs').writeFileSync('/app/runtime/package.json', JSON.stringify({ type: 'module', private: true, dependencies: { pg: '^8.16.3', '@neynar/nodejs-sdk': '^3.137.2' } }, null, 2))"
RUN npm install --omit=dev --prefix /app/runtime

FROM node:22-slim
WORKDIR /app

COPY --from=build /app/runtime/package.json ./package.json
COPY --from=build /app/runtime/node_modules ./node_modules
COPY --from=build /app/dist/main.js ./dist/main.js

EXPOSE 4000 9094

CMD ["node", "dist/main.js"]
