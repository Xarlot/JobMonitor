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
# **The registration the web app is already pointed at wins**, whatever it is called. Looking it up
# by display name first would find a different one — or none — and then create a second, pointing the
# app at fresh credentials while the registration people had already consented to sat unused. Asking
# the web app is the only way to be certain of configuring the one actually in the sign-in path.
CLIENT_ID="$(az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query 'identityProviders.azureActiveDirectory.registration.clientId' -o tsv 2>/dev/null || true)"

if [[ -n "$CLIENT_ID" && "$CLIENT_ID" != "None" ]]; then
  echo "  already configured on the web app"
fi

# Then by display name, so a re-run does not leave a second registration behind. `az ad app list`
# answers empty rather than failing when there is none, hence the `-o tsv` and the empty check.
if [[ -z "$CLIENT_ID" || "$CLIENT_ID" == "None" ]]; then
  CLIENT_ID="$(az ad app list --display-name "$APP" --query '[0].appId' -o tsv 2>/dev/null || true)"
fi

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
# Easy Auth signs people in with the authorization code flow, which exchanges the code for a token
# at `/.auth/login/aad/callback` — and that exchange needs a **client secret**. Without one the sign-in
# starts correctly, the user authenticates, and the callback answers 401: the failure lands at the end
# of the flow, where it looks like a redirect-URI or consent problem rather than a missing credential.
#
# The portal's "Add identity provider" wizard creates the secret silently, which is why this is easy
# to miss when the same thing is done with `az webapp auth microsoft update --client-id --tenant-id`:
# those flags configure everything except the one value the flow cannot work without.
SECRET_SETTING="MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"

say "Checking the client secret"
HAVE_SETTING="$(az webapp config appsettings list \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query "[?name=='${SECRET_SETTING}'].value" -o tsv 2>/dev/null || true)"
HAVE_REF="$(az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query 'identityProviders.azureActiveDirectory.registration.clientSecretSettingName' \
  -o tsv 2>/dev/null || true)"
echo "  app setting present: $([[ -n "$HAVE_SETTING" ]] && echo yes || echo no)"
echo "  referenced by auth:  ${HAVE_REF:-no}"

if [[ -z "$HAVE_SETTING" ]]; then
  say "Creating a client secret"
  # --append, emphatically: without it `credential reset` **deletes every existing credential** on
  # the registration first. Nothing else uses this one today, but a command whose failure mode is
  # "silently revoked something else" should not be one flag away from that.
  #
  # Captured into a variable and written through a file, never onto a command line: `az` invocations
  # appear in shell history and in `ps` output while they run.
  APP_SECRET="$(az ad app credential reset --id "$CLIENT_ID" --append \
    --display-name app-service-easy-auth --years 2 --query password -o tsv)"

  SETTINGS="$(mktemp)"
  chmod 600 "$SETTINGS"
  printf '[{"name":"%s","value":"%s","slotSetting":false}]' "$SECRET_SETTING" "$APP_SECRET" > "$SETTINGS"
  az webapp config appsettings set \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --settings "@$SETTINGS" --output none
  rm -f "$SETTINGS"
  unset APP_SECRET
  echo "  created, expires in 2 years"
else
  echo "  reusing the existing secret"
fi

say "Requiring authentication, and excluding the ingest route"
CONFIG="$(mktemp)"
az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" -o json > "$CONFIG"

# `clientSecretSettingName` is set in the same read-modify-write, because a secret that exists as an
# app setting but is not referenced from the auth configuration produces exactly the same 401.
jq --arg secretSetting "$SECRET_SETTING" \
   '.platform.enabled = true
    | .globalValidation.unauthenticatedClientAction = "RedirectToLoginPage"
    | .globalValidation.excludedPaths = ["/api/ingest"]
    | .identityProviders.azureActiveDirectory.registration.clientSecretSettingName = $secretSetting' \
   "$CONFIG" > "${CONFIG}.new"

az webapp auth set \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --body "@${CONFIG}.new" \
  --output none
rm -f "$CONFIG" "${CONFIG}.new"

say "Verifying"
# `secret` reports the setting *name*, never a value — that is all the configuration holds.
state=$(az webapp auth show --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query '{enabled:platform.enabled, action:globalValidation.unauthenticatedClientAction, excluded:globalValidation.excludedPaths, clientId:identityProviders.azureActiveDirectory.registration.clientId, secret:identityProviders.azureActiveDirectory.registration.clientSecretSettingName}' -o json)
echo "  $state"

say "Restarting so the new settings are picked up"
az webapp restart --name "$APP" --resource-group "$RESOURCE_GROUP" --output none

cat <<EOF

Authentication enabled. Confirm it from outside — 401 or a redirect to login, not a 200:

  curl -s -o /dev/null -w '%{http_code}\\n' https://${APP}.azurewebsites.net/

A 200 means the pages are still open and something above did not apply. 401 is what you want from
curl: Easy Auth only redirects requests that look like a browser's, so a 302 appears in a browser
and a 401 on the command line — the same state, reported two ways.

Then sign in **in a browser**, which is the only way to test the half that curl cannot reach. If it
ends at /.auth/login/aad/callback with a 401, the code-for-token exchange failed, and a missing or
expired client secret is the first thing to check.

That secret expires in two years. When it does, sign-in breaks for everyone at once while the app
itself keeps running perfectly — re-running this script issues a new one.

To restrict further to specific people or a group, assign users to the app registration in
Entra ID and set "User assignment required" on the enterprise application.
EOF
