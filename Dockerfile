# Сборка веб-клиента
FROM node:22-slim AS client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

# Сервер
FROM node:22-slim
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY --from=client /app/client/dist /app/client/dist

ENV NODE_ENV=production \
    PORT=8080 \
    HTTPS_PORT=8443 \
    DATA_DIR=/data \
    STATIC_DIR=/app/client/dist

VOLUME ["/data"]
EXPOSE 8080 8443
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "src/index.js"]
