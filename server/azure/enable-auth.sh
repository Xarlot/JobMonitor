#!/usr/bin/env bash
#
# Put the dashboard behind Entra ID.
#
# **Run this before the first deployment carries real data.** Until it does, the dashboard is
# reachable by anyone who knows the URL. The telemetry itself is anonymous, but installation counts,
# crash traces and version spread are internal information, and "nobody will guess the hostname" is
# not access control.
#
# App Service's built-in authentication is used rather than anything in the application: it runs in
# front of the process, so there is no unauthenticated code path to get wrong, and access is managed
# with the same directory as everything else — including revocation, which is the part a hand-rolled
# login always gets wrong.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-jobmonitor-telemetry-rg}"
APP="${APP:-jobmonitor-telemetry}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Enabling Entra ID authentication on ${APP}"
# --action login-with-azure-active-directory: unauthenticated requests are redirected to sign in
# rather than served. The default (allow-anonymous) would leave the pages open.
az webapp auth microsoft update \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --yes \
  --output none

az webapp auth update \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --enabled true \
  --action LoginWithAzureActiveDirectory \
  --redirect-provider AzureActiveDirectory \
  --output none

say "Excluding the ingest route"
# The scheduled trigger is a GitHub Actions job with no Entra identity, so it cannot pass an
# interactive sign-in. The route carries its own bearer token instead — and it is not a telemetry
# ingestion endpoint in any case: it accepts no batch, only a nudge to go and read Ably.
az webapp auth update \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --excluded-paths "/api/ingest" \
  --output none

say "Verifying"
state=$(az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query '{enabled:platform.enabled, action:globalValidation.unauthenticatedClientAction}' -o tsv)
echo "  $state"

cat <<EOF

Authentication enabled. Confirm it from outside — a redirect to login, not a 200:

  curl -s -o /dev/null -w '%{http_code}\\n' https://${APP}.azurewebsites.net/

A 200 means the pages are still open and something above did not apply.
A 302 to login.microsoftonline.com is what you want.

To restrict further to specific people or a group, assign users to the app registration in
Entra ID and set "User assignment required" on the enterprise application.
EOF
