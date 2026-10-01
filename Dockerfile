FROM node:22-slim

# Prisma's schema engine needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .

# The SQLite database lives on a volume, so it survives updates.
ENV DATABASE_URL="file:/app/data/bot.db"
VOLUME /app/data

CMD ["npm", "start"]
