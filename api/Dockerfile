FROM node:22.23.3-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
RUN npm run build

FROM node:22.23.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER node
EXPOSE 3000
# Migrations rodam como tarefa separada (servico `tools`), nao no boot: assim
# uma replica da API consegue subir mesmo com o banco em failover.
CMD ["node", "dist/src/server.js"]
