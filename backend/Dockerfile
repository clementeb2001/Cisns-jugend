# Backend + statisches Frontend in einem Container.
#
# Mehrstufiger Build: In der Build-Stufe wird better-sqlite3 nativ kompiliert
# (dafür sind python3/make/g++ nötig). Ins fertige Laufzeit-Image kommen NUR die
# fertigen node_modules – ohne Compiler. Das macht das Image deutlich kleiner
# und schneller zu laden (weniger Angriffsfläche, schnellere Updates aufs NAS).

# ---- Build-Stufe: Abhängigkeiten reproduzierbar installieren + kompilieren ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# Nur die Manifeste kopieren -> Docker-Cache greift, solange sich Abhängigkeiten
# nicht ändern. npm ci installiert exakt die Versionen aus package-lock.json.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ---- Laufzeit-Stufe: schlank, ohne Build-Werkzeuge ----
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV FRONTEND_DIR=/frontend
ENV DB_PATH=/data/jugendfeuerwehr.db

# Fertige Abhängigkeiten aus der Build-Stufe übernehmen (gleiche Basis -> passt)
COPY --from=build /app/node_modules ./node_modules
COPY backend/src ./src
COPY frontend /frontend

EXPOSE 3000
VOLUME ["/data"]

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
