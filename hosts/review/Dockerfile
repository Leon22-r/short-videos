FROM docker.io/library/node:26-alpine
WORKDIR /app
# No package.json: this service has no dependencies by design.
COPY server.js render.js postgrest.js ./
USER node
CMD ["node", "server.js"]
