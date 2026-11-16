FROM node:24-alpine
RUN apk add --no-cache git docker-cli docker-cli-compose docker-cli-buildx
WORKDIR /updater
COPY updater.js package.json ./
ENV REPO_DIR=/repo
EXPOSE 9000
CMD ["node", "updater.js"]
