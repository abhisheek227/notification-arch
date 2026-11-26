FROM projectdiscovery/subfinder:latest AS subfinder

FROM node:24-alpine

RUN apk add --no-cache ca-certificates

COPY --from=subfinder /usr/local/bin/subfinder /usr/local/bin/subfinder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["node", "dist/main.js"]
