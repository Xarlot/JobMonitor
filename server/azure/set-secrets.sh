#!/usr/bin/env bash
#
# Push the receiver's secrets into App Service settings.
#
# Reads them from the environment or from a local `.env.receiver` (gitignored), so the values never
# appear in a command line — `az` invocations end up in shell history and in `ps` output while they
# run, and a receiver private key is the one credential in this system whose loss cannot be
# recovered without a client release.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-jobmonitor-telemetry-rg}"
APP="${APP:-jobmonitor-telemetry}"
ENV_FILE="${ENV_FILE:-.env.receiver}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  echo "Loaded ${ENV_FILE}"
fi

missing=()
for name in TELEMETRY_ABLY_SUBSCRIBE_KEY TELEMETRY_RECEIVER_SECKEYS TELEMETRY_DEPLOYMENT_ID INGEST_TOKEN; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done

if (( ${#missing[@]} )); then
  cat >&2 <<EOF
Missing: ${missing[*]}

Create ${ENV_FILE} (gitignored) with:

  # Ably key with subscribe + history on jobmonitor:telemetry:v1. NOT the client's publish key —
  # that one is publish-only and cannot read the channel.
  TELEMETRY_ABLY_SUBSCRIBE_KEY=appId.keyId:secret

  # Receiver private key(s), newest first. The PUBLIC half is baked into client builds; this is
  # the half that decrypts. Generate the pair with: npm run telemetry:keys
  TELEMETRY_RECEIVER_SECKEYS=<64 hex>

  TELEMETRY_DEPLOYMENT_ID=<32 hex>

  # Shared secret for POST /api/ingest, matching the INGEST_TOKEN repository secret used by the
  # telemetry-ingest workflow. Generate with: openssl rand -hex 32
  INGEST_TOKEN=<random>

  # Ably's retention for this channel, hours. 24 on the free tier, 72+ on Standard. An optimistic
  # value here does not fail loudly — it loses data.
  # ABLY_RETENTION_HOURS=24
EOF
  exit 1
fi

# --settings reads name=value pairs from a file with @, keeping the values off the command line.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<EOF
[
  {"name":"TELEMETRY_ABLY_SUBSCRIBE_KEY","value":"${TELEMETRY_ABLY_SUBSCRIBE_KEY}","slotSetting":false},
  {"name":"TELEMETRY_RECEIVER_SECKEYS","value":"${TELEMETRY_RECEIVER_SECKEYS}","slotSetting":false},
  {"name":"TELEMETRY_DEPLOYMENT_ID","value":"${TELEMETRY_DEPLOYMENT_ID}","slotSetting":false},
  {"name":"INGEST_TOKEN","value":"${INGEST_TOKEN}","slotSetting":false},
  {"name":"DEDUP_RETENTION_DAYS","value":"${DEDUP_RETENTION_DAYS:-7}","slotSetting":false},
  {"name":"ABLY_RETENTION_HOURS","value":"${ABLY_RETENTION_HOURS:-24}","slotSetting":false},
  {"name":"INGEST_INTERVAL_HOURS","value":"${INGEST_INTERVAL_HOURS:-8}","slotSetting":false},
  {"name":"SENDER_RATE_PER_HOUR","value":"${SENDER_RATE_PER_HOUR:-10}","slotSetting":false}
]
EOF

az webapp config appsettings set \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --settings "@$tmp" --output none

echo "Secrets set. Restarting so the subscriber picks them up."
az webapp restart --name "$APP" --resource-group "$RESOURCE_GROUP" --output none
echo "Check https://${APP}.azurewebsites.net/health — 'Receiver process' should read 'running'."
