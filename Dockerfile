FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN --mount=type=cache,id=watchlog-next-cache,target=/app/.next/cache npm run db:generate && npm test && npm run typecheck && npm run build

FROM node:22-bookworm-slim AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
RUN groupadd --system --gid 1001 cinema && useradd --system --uid 1001 --gid cinema cinema && mkdir -p /app/data && chown cinema:cinema /app/data
COPY --from=build --chown=cinema:cinema /app/.next/standalone ./
COPY --from=build --chown=cinema:cinema /app/.next/static ./.next/static
COPY --from=build --chown=cinema:cinema /app/public ./public
USER cinema
EXPOSE 3000
CMD ["node", "server.js"]
