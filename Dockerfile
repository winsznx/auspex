# Auspex — low-latency evidence/landing host.
# Runs the same one-process data plane; deployed to Fly `fra` (Frankfurt) so it
# sits next to the frankfurt Jito block engine (single-digit-ms RT) and bundles
# actually land — unlike the West-Africa dev machine (~600ms RT, 0 lands).
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Kept alive so we exec runs on demand via `fly ssh console -C "npm run run:evidence"`.
CMD ["sleep", "infinity"]
