FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY . .
# the SQLite file lives here; mounted from the host in the cluster
RUN mkdir /data && chown bun:bun /data
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/flightradar.db
USER bun
EXPOSE 3000
CMD ["bun", "server.ts"]
