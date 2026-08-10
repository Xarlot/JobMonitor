# Telemetry receiver + dashboard.
#
# Node 24 explicitly, and that is not a default: `node:sqlite` is unflagged from Node 24 onwards
# but needs `--experimental-sqlite` on 22. Pinning the runtime here rather than relying on whatever
# Node version App Service happens to offer is the whole reason this deploys as a container.
#
# The build stage installs the entire workspace lockfile, which includes Electron's ~100 MB binary
# — that belongs to the desktop client and has no business in this image. `--ignore-scripts` plus
# the skip flags stop it being downloaded, and Next's standalone output means none of it reaches
# the runtime stage anyway.

FROM node:24-bookworm-slim AS build
WORKDIR /src

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1

# Manifests first, so a source-only change reuses the dependency layer.
COPY package.json package-lock.json ./
COPY packages/telemetry-schema/package.json packages/telemetry-schema/
COPY server/telemetry-receiver/package.json server/telemetry-receiver/
RUN npm ci --ignore-scripts

COPY packages/telemetry-schema packages/telemetry-schema
COPY server/telemetry-receiver server/telemetry-receiver

WORKDIR /src/server/telemetry-receiver
RUN npx next build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# Unprivileged. The process needs to read one directory and open outbound sockets, nothing else.
RUN groupadd -r receiver && useradd -r -g receiver receiver

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    TELEMETRY_DB=/home/data/telemetry.db

# Standalone output: the server plus only the modules it actually reached for.
COPY --from=build /src/server/telemetry-receiver/.next/standalone ./
COPY --from=build /src/server/telemetry-receiver/.next/static ./server/telemetry-receiver/.next/static

# /home is where App Service mounts persistent storage. Created here so a first run on an empty
# mount does not fail on a missing directory.
RUN mkdir -p /home/data && chown -R receiver:receiver /home/data /app
USER receiver

EXPOSE 8080

# App Service probes HTTP. A receiver whose subscriber died still serves pages — deliberately, so
# the health page can report the failure — so this checks the web app is alive, and the dashboard
# reports on ingest separately.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/telemetry-receiver/server.js"]
