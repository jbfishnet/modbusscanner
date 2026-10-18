FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/modbus_readings.db

VOLUME ["/data"]
EXPOSE 8080

RUN mkdir -p /data && chown node:node /data
USER node

CMD ["node", "server-with-persistence.js"]
