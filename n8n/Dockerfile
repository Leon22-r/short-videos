ARG N8N_VERSION=2.25.7
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

USER root

RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu

RUN mkdir -p \
  /data/input/ssemble \
  /data/output/final \
  /data/assets/music \
  /data/assets/watermarks \
  /data/jobs \
  /data/logs \
  && chown -R node:node /data

USER node
