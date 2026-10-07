ARG N8N_VERSION=2.25.7
FROM alpine:3.22 AS media-tools

RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  py3-pip \
  ttf-dejavu \
  yt-dlp \
  && python3 -m pip install --break-system-packages --no-cache-dir -U yt-dlp

FROM docker.io/n8nio/n8n:${N8N_VERSION}

# The n8n image is Alpine-based but strips apk from the final runtime image.
# Install media tools in a matching Alpine stage, then copy the installed
# runtime tree into n8n.
USER root

COPY --from=media-tools /usr/bin/ffmpeg /usr/bin/ffmpeg
COPY --from=media-tools /usr/bin/ffprobe /usr/bin/ffprobe
COPY --from=media-tools /usr/bin/yt-dlp /usr/bin/yt-dlp
COPY --from=media-tools /usr/bin/python3 /usr/bin/python3
COPY --from=media-tools /usr/lib /usr/lib
COPY --from=media-tools /usr/share/fonts /usr/share/fonts
COPY --from=media-tools /etc/fonts /etc/fonts

RUN mkdir -p \
  /data/input/ssemble \
  /data/output/final \
  /data/assets/music \
  /data/assets/watermarks \
  /data/jobs \
  /data/logs \
  && chown -R node:node /data

USER node
