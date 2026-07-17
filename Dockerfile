FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json nest-cli.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# curl + jq for llmproxyctl
RUN apk add --no-cache curl jq

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/llmproxyctl /usr/local/bin/llmproxyctl
RUN chmod +x /usr/local/bin/llmproxyctl

USER node
EXPOSE 8000 8081
CMD ["node", "dist/main.js"]
