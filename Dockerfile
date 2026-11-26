FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Listens on port 80 inside the container (non-root: compose lowers net.ipv4.ip_unprivileged_port_start).
ENV DATA_DIR=/data PORT=80
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
