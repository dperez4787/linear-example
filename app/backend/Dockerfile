# Backend container image for Cloud Run. Built with `docker build` on the CI
# runner (never Cloud Build), and is the only container in the system — the SPA
# is served as static files by Firebase Hosting and is never containerized.
FROM node:24-slim

WORKDIR /app

# Copy the manifests and install production deps BEFORE copying src, so the
# dependency layer is cached and only reinstalls when package-lock.json changes.
# A src edit then rebuilds in seconds instead of re-running npm ci.
COPY package*.json ./
RUN npm ci --omit=dev

# Application code goes in its own layer, after the dependency layer above.
COPY src ./src

# Drop root: run as the unprivileged `node` user baked into the base image.
USER node

# CMD is a plain `node src/index.js` — NO `--env-file`. Cloud Run has no `.env`;
# it injects MONGODB_URI from Secret Manager into the real process environment.
# The `--env-file-if-exists` in the npm start script is local-dev only and must
# not leak into the container. The server listens on process.env.PORT, which
# Cloud Run injects and health-checks.
CMD ["node", "src/index.js"]
