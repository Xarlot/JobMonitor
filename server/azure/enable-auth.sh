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

# App Service's Entra provider needs an app registration to sign people in against, and a tenant to
# sign them in to. `az webapp auth microsoft update` does not create either — it only points the web
# app at them — so this did nothing but fail with "Either --issuer or --tenant-id must be specified".
TENANT_ID="$(az account show --query tenantId -o tsv)"
REDIRECT="https://${APP}.azurewebsites.net/.auth/login/aad/callback"

say "Finding or creating the app registration"
# Reused by display name so a re-run does not leave a second registration behind. `az ad app list`
# answers empty rather than failing when there is none, hence the `-o tsv` and the empty check.
CLIENT_ID="$(az ad app list --display-name "$APP" --query '[0].appId' -o tsv 2>/dev/null || true)"

if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  # Directory writes are a separate permission from resource writes: an operator who can create a
  # web app often cannot create a registration. Say which of the two failed, because the fix is a
  # different person.
  if ! CLIENT_ID="$(az ad app create \
        --display-name "$APP" \
        --sign-in-audience AzureADMyOrg \
        --web-redirect-uris "$REDIRECT" \
        --query appId -o tsv)"; then
    cat >&2 <<EOF

Could not create the app registration. That is a *directory* permission, separate from the ones
that provisioned the web app, so this may need someone with Application Developer in Entra.

The portal does the same thing in one step and is the easier route here:

  App Service → ${APP} → Authentication → Add identity provider → Microsoft
  → Create new app registration → Current tenant, single tenant
  → Restrict access: Require authentication
  → Unauthenticated requests: HTTP 302 redirect

Then re-run this script: it will find the registration and only set the excluded path.

EOF
    exit 1
  fi
  say "Created registration ${CLIENT_ID}"
else
  say "Reusing registration ${CLIENT_ID}"
  az ad app update --id "$CLIENT_ID" --web-redirect-uris "$REDIRECT" --output none
fi

# A freshly created web app can carry legacy `siteAuthSettings` — the v1 shape — even with auth
# switched off, and every v2 command then refuses with "Cannot use auth v2 commands when the app is
# using auth v1". `config-version upgrade` converts the settings in place; it is a no-op on an app
# that is already v2, but asked first so a re-run stays quiet.
say "Checking the auth configuration version"
CONFIG_VERSION="$(az webapp auth config-version show \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query configVersion -o tsv 2>/dev/null || true)"

if [[ "$CONFIG_VERSION" == "v1" ]]; then
  say "Upgrading auth settings from v1 to v2"
  az webapp auth config-version upgrade \
    --name "$APP" --resource-group "$RESOURCE_GROUP" --output none
else
  say "Already v2 (${CONFIG_VERSION:-unset})"
fi

say "Pointing ${APP} at it"
# Unauthenticated requests are redirected to sign in rather than served; the default,
# AllowAnonymous, would leave the pages open.
az webapp auth microsoft update \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --client-id "$CLIENT_ID" \
  --tenant-id "$TENANT_ID" \
  --yes \
  --output none

# One call, and every flag here is the **v2** spelling. v1 called this `--action` and took
# `LoginWithAzureActiveDirectory`; v2 calls it `--unauthenticated-client-action` and takes
# `RedirectToLoginPage`. The old names fail loudly, which is the good case — but only after the
# registration exists, so a half-applied script is the normal way to meet them.
#
# `--redirect-provider` is deliberately not passed: with exactly one identity provider configured
# there is nothing to choose between, and naming it is another spelling to get wrong.
#
# The ingest route is excluded in the same call. The scheduled trigger is a GitHub Actions job with
# no Entra identity, so it cannot pass an interactive sign-in; the route carries its own bearer token
# instead — and it is not an ingestion endpoint in any case, it accepts no batch, only a nudge to go
# and read Ably.
#
# Applied by reading the whole v2 configuration, editing it, and writing it back — not by named
# flags. Three attempts at this script died on flag spellings that differ between auth v1 and v2
# (`--action` vs `--unauthenticated-client-action`, and values to match), and `excludedPaths` has no
# flag *or* portal field at all: it exists only in the configuration object. Read-modify-write
# touches exactly the two properties it means to and cannot be defeated by a renamed option.
say "Requiring authentication, and excluding the ingest route"
CONFIG="$(mktemp)"
az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" -o json > "$CONFIG"

jq '.platform.enabled = true
    | .globalValidation.unauthenticatedClientAction = "RedirectToLoginPage"
    | .globalValidation.excludedPaths = ["/api/ingest"]' "$CONFIG" > "${CONFIG}.new"

az webapp auth set \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --body "@${CONFIG}.new" \
  --output none
rm -f "$CONFIG" "${CONFIG}.new"

say "Verifying"
state=$(az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query '{enabled:platform.enabled, action:globalValidation.unauthenticatedClientAction, excluded:globalValidation.excludedPaths}' -o json)
echo "  $state"

cat <<EOF

Authentication enabled. Confirm it from outside — a redirect to login, not a 200:

  curl -s -o /dev/null -w '%{http_code}\\n' https://${APP}.azurewebsites.net/

A 200 means the pages are still open and something above did not apply.
A 302 to login.microsoftonline.com is what you want.

To restrict further to specific people or a group, assign users to the app registration in
Entra ID and set "User assignment required" on the enterprise application.
EOF
