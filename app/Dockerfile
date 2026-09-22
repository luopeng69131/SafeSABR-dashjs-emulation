FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/html/index.html
COPY app.js policy.js baseline_rules.js flight_rescue_rule.js /usr/share/nginx/html/
COPY vendor/dash.all.min.js /usr/share/nginx/html/vendor/dash.all.min.js
COPY assets/ /usr/share/nginx/html/assets/
