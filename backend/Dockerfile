# Backend + statisches Frontend in einem Container
FROM node:22-bookworm-slim AS base
WORKDIR /app

# Build-Tools für better-sqlite3 (native Kompilierung)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Abhängigkeiten installieren
COPY backend/package.json ./package.json
RUN npm install --omit=dev

# Quellcode + Frontend kopieren
COPY backend/src ./src
COPY frontend /frontend

ENV NODE_ENV=production
ENV PORT=3000
ENV FRONTEND_DIR=/frontend
ENV DB_PATH=/data/jugendfeuerwehr.db

EXPOSE 3000
VOLUME ["/data"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
