FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN npm ci
COPY . .
RUN npm run check && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DESK_HOST=0.0.0.0 DESK_PORT=8787 DESK_MODE=shadow DESK_DB_PATH=/app/data/desk.db
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/dashboard/dist ./apps/dashboard/dist
COPY --from=build --chown=node:node /app/config ./config
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
