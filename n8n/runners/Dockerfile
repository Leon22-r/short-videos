ARG N8N_VERSION=2.25.7
FROM n8nio/runners:${N8N_VERSION}

USER root
RUN cd /opt/runners/task-runner-python \
	&& uv pip install youtube-transcript-api

COPY n8n-task-runners.json /etc/n8n-task-runners.json

USER runner
