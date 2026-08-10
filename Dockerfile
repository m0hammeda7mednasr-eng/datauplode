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

# package.json has a postinstall hook that runs `prisma generate`.
# Copy the Prisma schema before npm ci so Railway/Docker builds do not fail
# before the rest of the source tree is copied.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .

# Fail closed for production: materialize the strict existing-product matcher
# inside the image, verify its safety contract, then build the exact artifact.
RUN node scripts/enforce-strict-first5-runtime.mjs \
    && node scripts/strict-first5-runtime-safety-contract.mjs \
    && npx prisma generate \
    && npm run build

EXPOSE 3000

CMD ["npm", "start"]
