# SaaS Identity Center API — Express + PostgreSQL (port 4100)
# Build:  docker build -t saas-backend ./backend
# Run:    docker run -p 4100:4100 --env-file backend/.env saas-backend
# Every start applies pending db/migrations/*.sql, then starts the API.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4100

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY db ./db
COPY scripts/migrate.js scripts/create-admin.js scripts/generate-keys.js ./scripts/

USER node
EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["sh", "-c", "node scripts/migrate.js && exec node src/server.js"]
