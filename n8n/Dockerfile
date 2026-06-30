ARG N8N_VERSION=2.25.7
FROM alpine:3.22 AS ffmpeg-runtime

RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu

FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

USER root

COPY --from=ffmpeg-runtime /usr/bin/ffmpeg /usr/bin/ffprobe /usr/bin/
COPY --from=ffmpeg-runtime /usr/lib/ /usr/lib/
COPY --from=ffmpeg-runtime /lib/ /lib/
COPY --from=ffmpeg-runtime /etc/fonts/ /etc/fonts/
COPY --from=ffmpeg-runtime /usr/share/fonts/ /usr/share/fonts/

RUN mkdir -p \
  /data/input/ssemble \
  /data/output/final \
  /data/assets/music \
  /data/assets/watermarks \
  /data/jobs \
  /data/logs \
  && chown -R node:node /data

USER node
