FROM nginx:stable-alpine

# Remove default nginx site
RUN rm -rf /usr/share/nginx/html/*

# Copy React build
COPY build/ /usr/share/nginx/html/

# Copy nginx config
COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
