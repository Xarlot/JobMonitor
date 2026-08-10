#!/usr/bin/env bash
#
# The identity GitHub Actions deploys with.
#
# Separate from the registration that signs people into the dashboard, deliberately: they have
# different blast radii, and this one holds Contributor on the resource group. It authenticates by
# **federated credential** rather than a secret — GitHub presents a short-lived OIDC token, Entra
# trusts it for exactly one repository and one ref, and there is no client secret to leak or rotate.
#
# Idempotent: re-running finds the existing registration instead of making a second one.
set -euo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-jobmonitor-telemetry-rg}"
APP_NAME="${APP_NAME:-jobmonitor-telemetry-deploy}"
REPO="${REPO:-DevExpress/JavaJobMonitor}"
BRANCH="${BRANCH:-master}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

say "Finding or creating ${APP_NAME}"
APPID="$(az ad app list --display-name "$APP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"
if [[ -z "$APPID" || "$APPID" == "None" ]]; then
  APPID="$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)"
  echo "  created $APPID"
else
  echo "  reusing $APPID"
fi

# The service principal is what a role can be assigned to; the registration alone cannot hold one.
az ad sp create --id "$APPID" >/dev/null 2>&1 || true

say "Federated credential for ${REPO} on ${BRANCH}"
# Scoped to one repository and one ref. A token minted by any other repo, or by a pull request from
# a fork, does not match the subject and is refused — which is the whole reason this is preferable
# to a client secret sitting in a repository setting.
if ! az ad app federated-credential list --id "$APPID" --query "[?name=='github-${BRANCH}']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$APPID" --parameters "{
    \"name\": \"github-${BRANCH}\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${REPO}:ref:refs/heads/${BRANCH}\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" >/dev/null
  echo "  created"
else
  echo "  already there"
fi

SUB="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"

say "Contributor on ${RESOURCE_GROUP}"
# Scoped to the resource group, not the subscription: this identity exists to redeploy one web app.
az role assignment create --assignee "$APPID" --role Contributor \
  --scope "/subscriptions/${SUB}/resourceGroups/${RESOURCE_GROUP}" >/dev/null 2>&1 \
  && echo "  assigned" || echo "  already assigned"

cat <<EOF

Set these two as repository secrets:

  AZURE_CLIENT_ID=${APPID}
  AZURE_SUBSCRIPTION_ID=${SUB}

(AZURE_TENANT_ID is ${TENANT} and is already set.)
EOF
