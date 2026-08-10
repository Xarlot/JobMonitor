#!/usr/bin/env bash
#
# Provision the telemetry server + dashboard on Azure App Service.
#
# Idempotent: safe to re-run. Every `az ... create` here either creates or reports the existing
# resource, and secrets are only written if they are not already set (see gen-secrets.sh).
#
# What this deliberately does NOT create: any inbound path to telemetry. Batches arrive over an
# outbound WebSocket to Ably that the container opens itself. The HTTPS endpoint below serves the
# dashboard and nothing else — there is no ingest route to reach.
#
# Usage:
#   ./provision.sh                 # create or update everything
#   RESOURCE_GROUP=... ./provision.sh
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-jobmonitor-telemetry-rg}"
LOCATION="${LOCATION:-westeurope}"
PLAN="${PLAN:-jobmonitor-telemetry-plan}"
APP="${APP:-jobmonitor-telemetry}"
# B1: 1 core, 1.75 GB, ~$13/mo. Sized for ~50 installations publishing once an hour — the load is
# roughly 0.014 requests per second, so this is chosen for RAM headroom, not throughput.
SKU="${SKU:-B1}"
IMAGE="${IMAGE:-ghcr.io/devexpress/javajobmonitor/telemetry-receiver:latest}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Resource group ${RESOURCE_GROUP} (${LOCATION})"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none

say "App Service plan ${PLAN} (${SKU}, Linux)"
az appservice plan create \
  --name "$PLAN" --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" --sku "$SKU" --is-linux --output none

say "Web app ${APP}"
az webapp create \
  --name "$APP" --resource-group "$RESOURCE_GROUP" --plan "$PLAN" \
  --container-image-name "$IMAGE" --output none

say "Runtime settings"
# Always On is deliberately NOT required.
#
# Telemetry is pulled from Ably history on a schedule rather than received over a live subscription,
# so nothing has to be running when a message is published — a cold start that serves the ingest
# request is exactly as correct as a warm one. It is enabled below anyway because it costs nothing
# on a B1 plan and removes cold-start latency from the dashboard, but the system is correct without
# it, which is the property that matters.
#
# WEBSITES_ENABLE_APP_SERVICE_STORAGE mounts /home as persistent storage. The SQLite file lives
# there; without it the database is on ephemeral container disk and every restart loses everything.
az webapp config set \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --always-on true \
  --min-tls-version 1.2 \
  --http20-enabled true \
  --output none

az webapp config appsettings set \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --settings \
    WEBSITES_ENABLE_APP_SERVICE_STORAGE=true \
    WEBSITES_PORT=8080 \
    TELEMETRY_DB=/home/data/telemetry.db \
  --output none

say "Pinning to a single instance"
# Not a cost decision. SQLite lives on /home, which App Service backs with SMB, and SQLite over SMB
# is safe with one writer and corrupts with two. Scale-out must be impossible, not merely unused.
az appservice plan update \
  --name "$PLAN" --resource-group "$RESOURCE_GROUP" \
  --number-of-workers 1 --output none
az webapp update \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --set siteConfig.numberOfWorkers=1 --output none

say "HTTPS only"
az webapp update --name "$APP" --resource-group "$RESOURCE_GROUP" --https-only true --output none

cat <<EOF

$(printf '\033[1m')Provisioned.$(printf '\033[0m')

  Dashboard:  https://${APP}.azurewebsites.net
  Resource:   ${RESOURCE_GROUP} / ${APP}

Still to do, in order — the app will start but refuse to ingest until the first two are done:

  1. Secrets:        ./set-secrets.sh
  2. Authentication: ./enable-auth.sh          <-- the dashboard is PUBLIC until this runs
  3. Deploy:         push to master, or run the telemetry-deploy workflow
  4. Schedule:       set repo variable AZURE_WEBAPP_NAME and secret INGEST_TOKEN,
                     then the telemetry-ingest workflow runs 3x/day

Note on the ingest schedule: Ably's free tier keeps published messages for 24 hours, and three
runs a day leaves an 8-hour gap. Two consecutive failures are survivable; a third loses data
permanently. The dashboard also triggers an ingest when it finds stale data, which is the
practical safety net — check /health for the current margin.

EOF
