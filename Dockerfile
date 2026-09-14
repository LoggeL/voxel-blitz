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

# Retain the legacy data mount until existing deployments complete migration.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8070) + '/healthz').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server/index.js"]
