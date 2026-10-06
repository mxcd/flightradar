FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY server.ts index.html ./
ENV NODE_ENV=production PORT=3000
USER bun
EXPOSE 3000
CMD ["bun", "server.ts"]
