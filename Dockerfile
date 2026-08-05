FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Prisma needs OpenSSL and the scraper needs a real browser with its Linux dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .

RUN npx prisma generate \
    && npm run build

EXPOSE 3000

CMD ["npm", "start"]
