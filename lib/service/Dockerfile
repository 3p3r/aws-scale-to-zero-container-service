FROM nginx:alpine

RUN apk add --no-cache nodejs npm supervisor

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p /var/log/supervisor
COPY supervisord.conf /etc/supervisord.conf

EXPOSE 9050

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]

