# Telemetry server + dashboard

Receives Job Monitor's anonymous telemetry and shows it. A Next.js application deployed to Azure
App Service — a **separate application** from the Job Monitor client, with its own pipeline, its own
secrets and its own lifecycle.

| Application | Deploys to | Telemetry |
|---|---|---|
| Job Monitor, web (`dist/`) | GitHub Pages, `deploy-pages.yml` | **collects nothing** — no code path exists in that build |
| Job Monitor, desktop (Electron) | GitHub Releases, `desktop-release.yml` | collects and publishes to Ably |
| **This** (`server/telemetry-receiver`) | Azure App Service, `telemetry-deploy.yml` | receives and displays |

---

## Running it locally

Two modes. The first needs no credentials, so a fresh checkout works immediately.

### Offline — generated data

```bash
cd server/telemetry-receiver
npm run dev:seed     # three weeks of realistic telemetry into ./.data/telemetry.db
npm run dev          # http://localhost:3000
```

Every dashboard works against the seeded data. Ingest is unconfigured, so `/health` reports it and
the live poller stays idle — which is worth seeing at least once, because it is exactly what a
broken deployment looks like.

`npm run dev:reset` deletes the local database.

### Live — the real Ably channel

```bash
cp .env.local.example .env.local   # then fill in the LIVE values
npm run dev
```

You need an Ably key with **subscribe and history** on `jobmonitor:telemetry:v1`. The client's key
will not do: it is publish-only and returns 401 on history, which is the property that stops one
installation reading another's telemetry — so it refusing you here means it is working.

Watch a batch travel the whole path:

```bash
npm run dev:publish   # seals a batch with the real client code and publishes it
npm run dev:ingest    # reads history, validates, stores — prints the outcome
```

`dev:publish` uses a fixed synthetic installation id (`dddd…`) so test rows are identifiable and
can be deleted separately:

```sql
DELETE FROM usage WHERE installation = 'dddddddddddddddddddddddddddddddd';
```

Or just open a page — the live poller picks it up within seconds.

---

## How telemetry arrives

**Nothing is ever posted to this server.** It reaches *out* to Ably and reads history. There is one
HTTP route involved, `/api/ingest`, and it accepts no telemetry — only an authenticated nudge
saying "read now".

Three things trigger a read:

| Trigger | Cadence | Purpose |
|---|---|---|
| `telemetry-ingest.yml` | 3×/day (02:00, 10:00, 18:00 UTC) | completeness |
| Live poller | every ~20s while a page is open | latency |
| `POST /api/ingest` | manual | operations |

The live poller **terminates itself** a few minutes after the last page render, so an idle instance
does no work at all. It exists so that publishing a batch and seeing it takes seconds rather than up
to eight hours; the schedule is what guarantees the data arrives regardless.

### The one failure that cannot be repaired

Ably keeps a published message for a limited time — **24 hours on the free tier**. If the gap
between reads ever exceeds that, the messages in the gap are gone. Not delayed, not duplicated:
gone, with nothing reporting it, because the charts can only show what arrived.

At three runs a day the gap is 8 hours, so **two consecutive failed runs are survivable and a third
is not**. `assertScheduleFitsRetention` refuses to run a schedule that could not survive two, and
`/health` shows the live margin to expiry. Raising `ABLY_RETENTION_HOURS` to 72 on a paid plan turns
that tolerance from two failures into eight.

---

## Deploying

```bash
cd server/azure
./provision.sh        # resource group, plan, web app
./set-secrets.sh      # reads .env.receiver (gitignored), never puts values on a command line
./enable-auth.sh      # Entra ID — the dashboard is PUBLIC until this runs
```

Then push to `master`, or run the **Deploy telemetry server** workflow. It builds a container,
pushes it to ghcr.io and deploys **by digest** — never by a floating tag, because `:latest` makes
"what is actually running" unanswerable afterwards.

Repository settings the workflows need:

| Kind | Name |
|---|---|
| Variable | `AZURE_WEBAPP_NAME`, `AZURE_RESOURCE_GROUP` |
| Secret | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `INGEST_TOKEN` |

### Why one instance, and why that is not negotiable

The database is SQLite on `/home`, which App Service backs with SMB. SQLite over SMB is safe with
one writer and corrupts with two, so `provision.sh` pins the plan to a single worker. Scale-out must
be impossible rather than merely unused. `journal_mode` is `DELETE` for the same reason — WAL needs
shared-memory coordination that SMB does not provide, and its failure mode is corruption rather than
an error.

---

## Cost

| | |
|---|---|
| App Service Linux B1 | $13.14/mo |
| Azure Files (<1 GB) | ~$0.06/mo |
| Ably | free tier — ~36,000 messages/mo against an allowance of 6,000,000 |
| **Total** | **~$13.20/mo** |

---

## What is in here

```
src/lib/          db, config, queries, live poller, logging
src/receiver/     pipeline, privacy validation, storage, Ably history puller
src/app/          dashboards (React Server Components; charts are server-rendered SVG, no client JS)
scripts/          development tools — seed, publish, ingest
test/             pipeline and schedule tests
```

Two things worth knowing before changing anything:

**The dedup row is written after the data, in the same transaction.** Writing it first is the
natural way and it loses batches silently: a crash between the two means the batch is replayed later
and immediately discarded as already-processed.

**Logs never contain values.** On a validation failure the rule and the field name are recorded,
never the content. A privacy validator that logs what it rejected has moved the problem somewhere
with weaker retention, not solved it.
