FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
# /app/data is only the in-container fallback; the deployment mounts the
# persistent volume at /data and points DATA_DIR there (deploy.json).
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
