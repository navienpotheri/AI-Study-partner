FROM node:20-alpine

WORKDIR /app

# No npm dependencies: the server uses only Node built-ins.
COPY package.json ./
COPY server.js ./
COPY data ./data
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
