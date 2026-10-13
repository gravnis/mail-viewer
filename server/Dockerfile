FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]

# node:sqlite is still behind a flag in Node 22.
CMD ["node", "--experimental-sqlite", "src/index.js"]
