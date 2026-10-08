# SaaS Manager dashboard — Vite build served by nginx (port 80)
# Build:  docker build -t saas-frontend \
#           --build-arg VITE_API_BASE_URL=https://saas-api.example.com/api/v1 ./frontend
# Run:    docker run -p 8080:80 saas-frontend

# ---------- 1. build ----------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
# The API URL is baked into the bundle at build time.
#   VITE_API_BASE_URL   where the dashboard calls the API (…/api/v1)
#   VITE_PUBLIC_API_URL the API origin shown to portal developers (Integration tab); defaults from the above
ARG VITE_API_BASE_URL
ARG VITE_PUBLIC_API_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_PUBLIC_API_URL=$VITE_PUBLIC_API_URL
RUN npm run build

# ---------- 2. serve ----------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
