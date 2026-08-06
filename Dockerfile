# Multi-stage Docker build for gateway-whatsapp-bot
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache git python3 make g++

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache git

COPY package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
