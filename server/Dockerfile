FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY migrations ./migrations
RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 3000
CMD ["/bin/sh", "-c", "node scripts/db.mjs migrate && exec node dist/index.js"]
