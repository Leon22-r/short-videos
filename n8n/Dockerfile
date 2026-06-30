ARG N8N_VERSION=2.25.7
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

# The n8n image is Alpine-based, so install ffmpeg straight from apk against the
# image's own package repo. This avoids copying a foreign Alpine's /usr/lib and
# /lib over the n8n runtime libraries, which risks musl/libstdc++ ABI mismatches
# that break n8n silently and re-break on every base-image bump.
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
