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
#
# ## Why this talks to ARM directly
#
# The auth configuration is read and written through `az rest` against the `authsettingsV2` resource,
# not through `az webapp auth`. Four earlier versions of this script died on that command family:
#
#   - the v1 and v2 flags have different names for the same settings (`--action` versus
#     `--unauthenticated-client-action`), and the wrong one fails only once a registration exists,
#   - `excludedPaths` has no flag at all, and no field in the portal either,
#   - and finally, once the `authV2` extension installed itself, `az webapp auth show` began
#     answering `null` for an app whose configuration it had returned correctly the day before.
#     The CLI says as much — "The behavior of this command has been altered by the following
#     extension: authV2" — but a command that silently returns nothing is worse than one that fails:
#     a read-modify-write on `null` produces a document that describes an app with no authentication.
#
# The REST contract does not move under us and does not depend on which extensions are installed.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-jobmonitor-telemetry-rg}"
APP="${APP:-jobmonitor-telemetry}"
API_VERSION="${API_VERSION:-2023-01-01}"
SECRET_SETTING="MICROSOFT_PROVIDER_AUTHENTICATION_SECRET"
CRED_NAME="app-service-easy-auth"
# Set FORCE_NEW_SECRET=1 to issue a fresh client secret even when one is already wired up — which is
# what to reach for when sign-in fails and the existing secret has simply expired.
FORCE_NEW_SECRET="${FORCE_NEW_SECRET:-0}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# `az` asks before installing a command's extension, and it asks on stderr. An earlier version of
# this script discarded stderr on its lookups to keep expected "not found" noise down, and the effect
# was a script that sat silently at a step forever: the question went to a discarded stream and the
# answer never came. Nothing here discards stderr, and this removes the question as well.
az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors >/dev/null 2>&1 || true

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
chmod 700 "$WORK"

SUBSCRIPTION="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"
ISSUER="https://login.microsoftonline.com/${TENANT_ID}/v2.0"
REDIRECT="https://${APP}.azurewebsites.net/.auth/login/aad/callback"
SITE="https://management.azure.com/subscriptions/${SUBSCRIPTION}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.Web/sites/${APP}"

# ---------------------------------------------------------------------------------------------------
# Read the current configuration
# ---------------------------------------------------------------------------------------------------

# One function for both reads, because there are two — before the edit and after it — and the first
# version of this script had them as separate lines. Fixing the method on one left the other on POST,
# so the write succeeded and the verification step was what failed. Anything read twice should be read
# by one piece of code.
#
# GET, not the POST `.../list` that app settings use. Reading through a POST is the pattern for
# settings that contain secrets; this resource holds only the *name* of the setting carrying the client
# secret, so it is readable by GET — and answers `Method Not Allowed` to a POST at this API version.
# The POST stays as a fallback for older ones.
read_auth() {
  local out="$1"
  if ! az rest --method get --url "${SITE}/config/authsettingsV2?api-version=${API_VERSION}" \
       -o json > "$out" 2>"$WORK/err"; then
    echo "  GET failed, trying POST .../list" >&2
    cat "$WORK/err" >&2
    az rest --method post --url "${SITE}/config/authsettingsV2/list?api-version=${API_VERSION}" \
      -o json > "$out"
  fi
}

say "Reading the current auth configuration"
CFG="$WORK/auth.json"
read_auth "$CFG"

# Printed, not assumed. The whole reason this script is on its fifth version is that each one acted
# on a belief about this document instead of on the document.
echo "  bytes: $(wc -c < "$CFG")"
echo "  top-level keys: $(jq -c 'keys' "$CFG")"
echo "  platform.enabled: $(jq -c '.properties.platform.enabled' "$CFG")"
echo "  unauthenticatedClientAction: $(jq -c '.properties.globalValidation.unauthenticatedClientAction' "$CFG")"
echo "  redirectToProvider: $(jq -c '.properties.globalValidation.redirectToProvider' "$CFG")"
echo "  excludedPaths: $(jq -c '.properties.globalValidation.excludedPaths' "$CFG")"
echo "  clientId: $(jq -r '.properties.identityProviders.azureActiveDirectory.registration.clientId // "unset"' "$CFG")"
echo "  clientSecretSettingName: $(jq -r '.properties.identityProviders.azureActiveDirectory.registration.clientSecretSettingName // "unset"' "$CFG")"

say "Identity providers before"
jq -r '.properties.identityProviders // {} | to_entries[]
       | select((.value | type) == "object")
       | "  \(.key): enabled=\(if (.value | has("enabled")) then (.value.enabled | tostring) else "unset" end)"
         + " registration=\(if ((.value.registration.clientId // .value.registration.appId // .value.registration.consumerKey // "") | length) == 0 then "empty" else "set" end)"' \
   "$CFG" || echo "  (none)"

# ---------------------------------------------------------------------------------------------------
# The app registration people sign in against
# ---------------------------------------------------------------------------------------------------

say "Finding or creating the app registration"
# **The registration already named in the configuration wins**, whatever it is called. Looking it up
# by display name first can find a different one — or none — and then create a second, pointing the
# app at fresh credentials while the registration people had already consented to sits unused.
CLIENT_ID="$(jq -r '.properties.identityProviders.azureActiveDirectory.registration.clientId // ""' "$CFG")"
if [[ -n "$CLIENT_ID" ]]; then
  echo "  taken from the auth configuration: $CLIENT_ID"
else
  CLIENT_ID="$(az ad app list --display-name "$APP" --query '[0].appId' -o tsv || true)"
  [[ "$CLIENT_ID" == "None" ]] && CLIENT_ID=""
  [[ -n "$CLIENT_ID" ]] && echo "  found by display name: $CLIENT_ID"
fi

if [[ -z "$CLIENT_ID" ]]; then
  # Directory writes are a separate permission from resource writes: an operator who can create a web
  # app often cannot create a registration. Say which of the two failed, because the fix is a
  # different person.
  if ! CLIENT_ID="$(az ad app create \
        --display-name "$APP" \
        --sign-in-audience AzureADMyOrg \
        --web-redirect-uris "$REDIRECT" \
        --query appId -o tsv)"; then
    cat >&2 <<EOF

Could not create the app registration. That is a *directory* permission, separate from the ones that
provisioned the web app, so this may need someone with Application Developer in Entra.

EOF
    exit 1
  fi
  echo "  created: $CLIENT_ID"
else
  az ad app update --id "$CLIENT_ID" --web-redirect-uris "$REDIRECT" --output none
  echo "  redirect URI confirmed"
fi

# ---------------------------------------------------------------------------------------------------
# The client secret
# ---------------------------------------------------------------------------------------------------

# Easy Auth signs people in with the authorization code flow, and exchanges the code for a token at
# `/.auth/login/aad/callback`. That exchange needs a client secret, and it needs the configuration to
# *point at* it: an app setting holding a perfectly good secret that nothing references fails exactly
# like having no secret at all. Both halves are set here, because the observed failure was the second
# one — `app setting present: yes`, `referenced by auth: no` — which is invisible from the portal and
# indistinguishable from a redirect-URI problem when you only see the 401 at the end of the flow.
say "Checking the client secret"
# Announced before it runs. This call takes several seconds against a warm subscription and longer
# against a cold one, and a step that prints only after finishing is indistinguishable from the hang
# this script produced earlier — which is exactly why the previous run was interrupted here.
echo "  listing app settings (a few seconds)..."
HAVE_SETTING="$(az webapp config appsettings list \
  --name "$APP" --resource-group "$RESOURCE_GROUP" \
  --query "[?name=='${SECRET_SETTING}'].name" -o tsv || true)"
HAVE_REF="$(jq -r '.properties.identityProviders.azureActiveDirectory.registration.clientSecretSettingName // ""' "$CFG")"
echo "  app setting present: $([[ -n "$HAVE_SETTING" ]] && echo yes || echo no)"
echo "  referenced by auth:  ${HAVE_REF:-no}"

if [[ -z "$HAVE_SETTING" || -z "$HAVE_REF" || "$FORCE_NEW_SECRET" == "1" ]]; then
  say "Issuing a client secret"
  # --append, emphatically: without it `credential reset` **deletes every existing credential** on the
  # registration first. A command whose failure mode is "silently revoked something else" should not
  # be one flag away from that.
  #
  # A new secret rather than trusting the existing app setting, because its value cannot be read back
  # to check — and an expired or mismatched secret produces the identical 401. The old one stays valid
  # and simply goes unused.
  APP_SECRET="$(az ad app credential reset --id "$CLIENT_ID" --append \
    --display-name "$CRED_NAME" --years 2 --query password -o tsv)"

  # Written through a file: `az` invocations appear in shell history and in `ps` output while running.
  SETTINGS="$WORK/settings.json"
  : > "$SETTINGS"; chmod 600 "$SETTINGS"
  jq -n --arg n "$SECRET_SETTING" --arg v "$APP_SECRET" \
     '[{name: $n, value: $v, slotSetting: false}]' > "$SETTINGS"
  az webapp config appsettings set \
    --name "$APP" --resource-group "$RESOURCE_GROUP" \
    --settings "@$SETTINGS" --output none
  unset APP_SECRET
  echo "  issued, stored in ${SECRET_SETTING}, expires in 2 years"
else
  echo "  already wired up — run again with FORCE_NEW_SECRET=1 to replace it"
fi

# ---------------------------------------------------------------------------------------------------
# Write the configuration
# ---------------------------------------------------------------------------------------------------

say "Requiring authentication, naming the provider, excluding the ingest route"
# Every field that matters is set explicitly rather than relied upon to be present, so this produces a
# correct document whether the app arrives configured, half-configured, or empty.
#
# `redirectToProvider` is one of them. An earlier version left it unset, on the reasoning that "with
# exactly one identity provider configured there is nothing to choose between" — an assumption about
# the intended configuration rather than the real one. When `RedirectToLoginPage` has no unambiguous
# destination, Easy Auth answers 401 to every path *including its own* `/.auth/login/*` endpoints, and
# a blanket 401 that also covers a provider name which does not exist is the signature of that state.
#
# Providers other than this one are disabled if they were enabled, and only then — nothing is deleted,
# so it is reversible, and a provider with an empty registration is inert either way.
# `customOpenIdConnectProviders` is excluded by name: it is a map of providers rather than a provider,
# and would otherwise acquire a meaningless `enabled` field.
BODY="$WORK/body.json"
jq --arg clientId "$CLIENT_ID" \
   --arg issuer "$ISSUER" \
   --arg secretSetting "$SECRET_SETTING" \
   '(.properties // {})
    | .platform.enabled = true
    | .globalValidation.requireAuthentication = true
    | .globalValidation.unauthenticatedClientAction = "RedirectToLoginPage"
    | .globalValidation.redirectToProvider = "azureActiveDirectory"
    | .globalValidation.excludedPaths = ["/api/ingest"]
    | .login.tokenStore.enabled = true
    | .identityProviders.azureActiveDirectory.enabled = true
    | .identityProviders.azureActiveDirectory.registration.clientId = $clientId
    | .identityProviders.azureActiveDirectory.registration.openIdIssuer = $issuer
    | .identityProviders.azureActiveDirectory.registration.clientSecretSettingName = $secretSetting
    | .identityProviders |= with_entries(
        if (.key == "azureActiveDirectory" or .key == "customOpenIdConnectProviders") then .
        elif ((.value | type) == "object") and (.value.enabled == true) then .value.enabled = false
        else . end)
    | {properties: .}' "$CFG" > "$BODY"

# Checked before it is applied. This replaces the *entire* auth configuration in one call, so a jq
# expression that succeeded while producing the wrong shape would not fail loudly — it would hand
# App Service a valid document describing an app with no authentication on it. `set -e` covers jq
# exiting non-zero; this covers jq exiting zero with the wrong thing.
if ! jq -e '.properties.platform.enabled == true
            and (.properties.globalValidation.requireAuthentication == true)
            and (.properties.globalValidation.redirectToProvider == "azureActiveDirectory")
            and ((.properties.globalValidation.excludedPaths // []) | index("/api/ingest") != null)
            and ((.properties.identityProviders.azureActiveDirectory.registration.clientId // "") | length > 0)
            and ((.properties.identityProviders.azureActiveDirectory.registration.clientSecretSettingName // "") | length > 0)' \
     "$BODY" > /dev/null; then
  echo "Refusing to apply: the document being sent is missing something it must have." >&2
  jq -c '.properties | {platform, globalValidation, aad: .identityProviders.azureActiveDirectory}' "$BODY" >&2
  exit 1
fi

az rest --method put \
  --url "${SITE}/config/authsettingsV2?api-version=${API_VERSION}" \
  --headers Content-Type=application/json \
  --body "@$BODY" \
  --output none

say "Restarting so the new settings are picked up"
az webapp restart --name "$APP" --resource-group "$RESOURCE_GROUP" --output none

# ---------------------------------------------------------------------------------------------------
# Read it back
# ---------------------------------------------------------------------------------------------------

say "Verifying — read back from ARM, not from what we sent"
read_auth "$WORK/after.json"
jq -r '.properties
       | "  platform.enabled:        \(.platform.enabled)",
         "  requireAuthentication:   \(.globalValidation.requireAuthentication)",
         "  unauthenticatedAction:   \(.globalValidation.unauthenticatedClientAction)",
         "  redirectToProvider:      \(.globalValidation.redirectToProvider)",
         "  excludedPaths:           \(.globalValidation.excludedPaths | tostring)",
         "  clientId:                \(.identityProviders.azureActiveDirectory.registration.clientId)",
         "  clientSecretSettingName: \(.identityProviders.azureActiveDirectory.registration.clientSecretSettingName)",
         "  openIdIssuer:            \(.identityProviders.azureActiveDirectory.registration.openIdIssuer)"' \
   "$WORK/after.json"

say "Identity providers after"
jq -r '.properties.identityProviders // {} | to_entries[]
       | select((.value | type) == "object")
       | "  \(.key): enabled=\(if (.value | has("enabled")) then (.value.enabled | tostring) else "unset" end)"' \
   "$WORK/after.json"

cat <<EOF

Now sign in **in a browser, in a private window**. Stale .auth cookies produce their own 401s and are
easy to mistake for the real thing.

From the command line, 401 is the expected answer and not a fault: Easy Auth only redirects requests
that look like a browser's, so the same state reads as a 302 in a browser and a 401 under curl. What
would be wrong is a 200 — that would mean the pages are open.

  curl -s -o /dev/null -w '%{http_code}\\n' https://${APP}.azurewebsites.net/

The client secret expires in two years. When it does, sign-in breaks for everyone at once while the
app itself keeps serving perfectly — re-run this script with FORCE_NEW_SECRET=1 to issue another.
EOF
