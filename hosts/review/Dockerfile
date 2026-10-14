FROM docker.io/library/node:26-alpine
WORKDIR /app
# No package.json: this service has no dependencies by design.
# Named rather than COPY . so nothing stray is ever shipped. Adding a file to
# this service means adding it here too, or the container crash-loops on
# MODULE_NOT_FOUND.
COPY server.js render.js summarise.js postgrest.js ./
USER node
CMD ["node", "server.js"]
