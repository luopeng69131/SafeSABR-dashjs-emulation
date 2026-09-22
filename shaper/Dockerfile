FROM nginx:1.27-alpine

RUN apk add --no-cache bash iproute2 python3

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /opt/safesabr/entrypoint.sh
COPY replay_trace.py /opt/safesabr/replay_trace.py

RUN chmod 0755 /opt/safesabr/entrypoint.sh /opt/safesabr/replay_trace.py

ENTRYPOINT ["/opt/safesabr/entrypoint.sh"]
