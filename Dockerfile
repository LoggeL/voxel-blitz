FROM node:24-alpine@sha256:705813e7dd798f8a69a2b0d8fb958ecafe5fc3b2a52139ae03a0379246301c4a

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY shared ./shared
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8070

EXPOSE 8070

RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

CMD ["node", "server/index.js"]
