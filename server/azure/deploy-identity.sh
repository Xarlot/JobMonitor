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
# Must match `environment:` in .github/workflows/telemetry-deploy.yml — that name is half the subject
# the federated credential is checked against.
ENVIRONMENT="${ENVIRONMENT:-telemetry}"

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

say "Federated credential for ${REPO}, environment ${ENVIRONMENT}"
# The subject must match the token GitHub actually mints, and **a job that declares an environment
# gets an environment subject, not a branch one**: `repo:owner/name:environment:telemetry`, with no
# ref in it at all. A `ref:refs/heads/master` credential looks obviously right and is refused with
# AADSTS700213, naming the subject it wanted — read that message rather than re-deriving.
#
# Scoped to one repository and one environment. A token minted by any other repository, or by a job
# that does not enter this environment, does not match and is refused — which is the whole reason
# this is preferable to a client secret sitting in a repository setting.
if ! az ad app federated-credential list --id "$APPID" \
     --query "[?name=='github-env-${ENVIRONMENT}']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$APPID" --parameters "{
    \"name\": \"github-env-${ENVIRONMENT}\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"repo:${REPO}:environment:${ENVIRONMENT}\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" >/dev/null
  echo "  created"
else
  echo "  already there"
fi

# A branch-scoped credential from an earlier run is removed rather than left lying around. It is not
# merely unused: it would let a job that never enters the environment authenticate all the same,
# which quietly defeats any approval rule put on that environment later.
if az ad app federated-credential list --id "$APPID" \
   --query "[?name=='github-${BRANCH}'].id" -o tsv | grep -q .; then
  say "Removing the obsolete branch-scoped credential"
  az ad app federated-credential delete --id "$APPID" \
    --federated-credential-id "github-${BRANCH}" --yes >/dev/null 2>&1 \
    || az ad app federated-credential delete --id "$APPID" \
         --federated-credential-id "github-${BRANCH}" >/dev/null
  echo "  removed"
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
