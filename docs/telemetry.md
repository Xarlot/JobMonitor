# Telemetry

What the desktop app collects, what it deliberately does not, and how it travels.

This is the reference document. The user-facing summary is in the
[README's Privacy section](../README.md#privacy).

---

## Scope

**Only the Electron desktop app collects anything.** The GitHub Pages build has no code path that
can record or transmit telemetry — the renderer's aggregation layer is a no-op without a
`window.desktop` bridge, and the publisher lives entirely in the main process. The
Content-Security-Policy in `vite.config.ts` is unchanged and still limits `connect-src` to
`api.github.com`; the Ably connection is opened from Node, which no CSP applies to.

Collection is **always on with no opt-out**. In exchange, everything queued locally is visible in
**Settings → Diagnostics → Telemetry** and readable on disk as plain NDJSON.

Dev runs do not publish. `initTelemetry({ send: app.isPackaged })` means `npm run electron:dev` and
the Playwright screenshot scripts spool records but never open a socket — with ~50 installations,
developer noise would otherwise dominate the dataset.

---

## Identity

| Value | What it is | Where it lives |
|---|---|---|
| `installation_id` | 16 random bytes from `crypto.randomBytes`, generated on first run | `install.json`, mode `0600`; sent **inside** the encrypted payload only |
| Sender keypair | secp256k1, **generated fresh for every batch and discarded** | nowhere — never written to disk |
| `deployment_id` | 16 bytes baked into the build | sent inside the encrypted payload |
| Receiver public key | secp256k1, a build-time constant | shipped in the app; the private half exists only on the ingest server |
| Ably publish key | publish-only, scoped to one channel | baked into the build |

`installation_id` is never derived from a username, hostname, MAC address, Windows SID, MachineGuid,
CPU serial, GitHub identity, or any other hardware or account identifier. **It identifies an
installation, not a person**, and no mapping from it to a real identity exists anywhere.

The sender keypair exists only to derive an ECDH shared secret with the receiver. It is generated
per batch and thrown away, so it is not an identifier and nothing on disk ties two batches from the
same installation together. There is consequently no key rotation to schedule.

> **Known limitation.** The app is distributed to users, so both the Ably publish key and the
> receiver's public key can be extracted from a shipped binary. What that gets someone is bounded
> and worth stating plainly:
>
> - The Ably key is **publish-only and scoped to this one channel**. It cannot subscribe, so no
>   installation can read another's telemetry, and it cannot reach anything else in the account.
> - The receiver's *public* key only permits encrypting. Decryption needs the private half, which
>   exists only on the ingest VM.
> - Someone holding both can publish junk into our channel. `deployment_id`, schema validation and
>   receiver-side limits bound that; they do not eliminate it.
>
> The dashboards are advisory instruments, not audited records.

---

## What is collected

### Feature counters

A count per feature per reporting period. Features are **numeric IDs from a fixed registry** —
there is no string field, so nothing about your repositories can travel in one even by accident.

```
1  →  flows.pattern.used        = 12
2  →  artifacts.bundle.download = 3
3  →  ai.triage.deep            = 1
```

IDs are permanent: never renumbered, never reused, and a removed feature keeps a tombstone entry.
Adding a feature does **not** bump `schema_version` — the server maps an unrecognised ID to
`unknown(<id>)` rather than dropping the batch.

### Operation timings

Aggregated locally into a count, a sum, a max, and **8 histogram buckets**. Individual durations are
never transmitted.

| Bucket | Upper bound |
|---|---|
| 0 | 50 ms |
| 1 | 100 ms |
| 2 | 250 ms |
| 3 | 500 ms |
| 4 | 1 s |
| 5 | 2 s |
| 6 | 5 s |
| 7 | ∞ |

Eight rather than the four in the original design: four coarse buckets cannot produce even an
approximate percentile, and widening the schema after v1 ships would be a wire-format change.

Failures are counted per operation by **error category** — a small closed set (`NETWORK`, `TIMEOUT`,
`AUTH`, `PERMISSION`, `RATE_LIMIT`, `NOT_FOUND`, `CONFLICT`, `SERVER`, `PARSE`, `CANCELLED`,
`TOO_OLD`, `UNAVAILABLE`, `STORAGE`, `UNKNOWN`). Never a message, never a status line.

### Usage summaries

One record per **UTC hour bucket**. UTC rather than local time because a local-time bucket is
25 hours long at a DST transition and negative across a timezone change.

| Field | Meaning |
|---|---|
| `app_starts` | Process launches. A second-instance activation is not a start. |
| `session_count` | Sessions — one main-process lifetime each. |
| `foreground_seconds` | Window visible **and** focused. |
| `running_seconds` | Wall time the process was alive, credited by a 60-second heartbeat. |
| `clean_shutdowns` | Quits that ran the normal shutdown path. |
| `unclean_exits` | Detected at the *next* launch from a surviving session sentinel. |

`running_seconds` is credited as `min(60s, now − lastTick)`. The clamp is the point: a laptop asleep
for eight hours must not report eight hours of use — the timer does not fire, and the delta on wake
is clamped to a single interval.

Two fields rather than one "active seconds" because Job Monitor lives in the tray and keeps polling
with the window hidden. A single number would conflate "someone was working in it" with "it was
running", and those answer different questions.

### Crashes

Kept separate from usage counters and given eviction priority — a crash record survives a flood of
ordinary telemetry.

| Field | Notes |
|---|---|
| `occurred_at_ms` | — |
| `app_version` | Per-record, not just per-batch: the app auto-updates and restarts, so a crash is routinely recorded under one version and sent under another. |
| `source` | main-uncaught, main-rejection, renderer-gone, react-boundary, window-error, renderer-rejection, child-process-gone, unclean-exit |
| `exception_type` | `error.name` only. |
| `fingerprint` | `sha256(type + top 5 normalized frames)`, first 16 bytes. |
| `stack` | Sanitized, ≤ 4 KB. |
| `count` | Deduplicated occurrences of the same fingerprint. |

Repeated crashes are collapsed: at most 3 records per fingerprint and 20 crash records per session,
with the true count carried in `count`. A crash loop on a timer would otherwise evict everything
worth keeping from a size-capped file.

**Nothing is ever sent from a crash handler.** The record is persisted synchronously and travels on
a later, ordinary send cycle.

---

## What is never collected

**Your GitHub token.** It never reaches the main process at all.

Repository, branch, PR, workflow, job or artifact names. Log contents, annotation text, job
summaries, or anything returned by the GitHub API. File paths, filenames, usernames, hostnames, IP
addresses, MAC addresses. Command-line arguments and environment variables — not sanitized,
*not collected*, because a sanitizer you never have to trust beats one you do. Screen contents,
keystrokes, clipboard. Anything typed into a settings field.

**Exception messages.** Only `error.name` is kept. A message is the single most likely place for a
path, a URL or a token to end up in a crash report, and no sanitizer is worth betting on when the
field can simply not exist.

**Electron's `crashReporter` is deliberately never enabled.** It uploads native minidumps, and a
minidump contains process memory — which on this app contains the user's GitHub PAT.

### Stack trace sanitization

Applied in the main process at the moment of persistence, so an unsanitized trace never touches
disk. Ordered:

1. **Redact absolutes** across the whole string — home directory → `<home>`, user data directory →
   `<data>`, username → `<user>`, `ghp_…`-shaped tokens → `<token>`, long hex runs → `<hex>`.
   Case-insensitive, both path separators.
2. **Drop line 0 entirely.** In a V8 stack that line is `TypeError: <message>`. It is never parsed;
   the type comes from `error.name` instead.
3. Keep at most 12 frames.
4. Per frame keep only function name, module basename, line and column.
5. **Normalize locations** so a fingerprint survives a release:

   | Input | Output |
   |---|---|
   | `app://bundle/assets/index-Ab12Cd.js` | `app:/assets/index.js` |
   | `file:///…/app.asar/electron/main.cjs` | `asar:/electron/main.cjs` |
   | any other absolute path | last two segments |

   Stripping the Vite content hash is load-bearing — without it every release renumbers every
   fingerprint and crash grouping is worthless.
6. React `componentStack` reduced to bare component identifiers.
7. Cap at 4 KB.

The server independently rejects any trace that still matches an email, URL, Windows or POSIX home
path, UNC path, IP address, JWT, GitHub token, or long base64/hex blob — dropping the trace but
keeping the crash, because losing the *fact* of a crash is worse than losing its detail. That check
is a backstop; the client sanitizer is the primary control.

---

## Local storage

Under the user data directory, alongside the diagnostics log:

```
telemetry/
  crash.ndjson      priority 0    cap 1 MB
  failure.ndjson    priority 1    cap 1 MB
  usage.ndjson      priority 2    cap 2 MB
  install.json      installation id, mode 0600
  session.json      clean-shutdown sentinel
```

Newline-delimited JSON, one record per line, appended synchronously — a crash mid-write costs one
line rather than the file. Bounded at **7 days**.

Eviction, in order: records older than 7 days, then oldest usage, then oldest failure, then oldest
crash while always keeping the newest 20. **Crashes are never evicted to make room for usage.**
Every eviction increments a `dropped_records` counter carried in the next batch, so gaps in the
server-side data are visible rather than silent.

Actual volume is roughly 1.2 KB every 15 minutes — about 800 KB across the full 7-day window.

---

## Transport

```
protobuf → deflate → base64 → NIP-44 v2 encrypt → Ably message → channel jobmonitor:telemetry:v1
```

Transport is [Ably](https://ably.com), a managed pub/sub bus. Aggregated counters flush from memory
to the local queue every **15 minutes**; the queue publishes every **60 minutes ± 10 minutes** of
jitter. The first send after launch is delayed 60–120 seconds so 50 installations updating overnight
do not arrive simultaneously, and so telemetry never competes with the first GitHub polls.

The client holds **no persistent connection** — it connects, publishes, and disconnects. Retries
back off at roughly 1 min, 5 min, 15 min, 1 h, 4 h with jitter, and records stay in the local queue
until the publish is confirmed. Every batch carries a random 128-bit `batch_id` and the receiver
deduplicates, so a retry can never double-count.

**There is still no public ingestion endpoint on Azure.** The server *pulls* from Ably history on a
schedule; no batch is ever posted to it. There is one HTTP route involved — `/api/ingest` — and it
accepts no telemetry at all, only an authenticated nudge saying "read history now".

Delivery is covered by the platform rather than by an application-level acknowledgement protocol.
Ably stores published messages durably, so the server does not need to be running when a batch is
sent; it reads what accumulated since its last run. **On the free tier that window is 24 hours**,
and ingest runs three times a day, so two consecutive failed runs are survivable and a third would
lose whatever expired in the gap. Two things guard that margin: the dashboard triggers a read
whenever someone opens a page and the data is stale, and `/health` shows the live margin to expiry.
Beyond it, the client's own 7-day queue is what preserves the data.

Volume sits far inside the free tier: ~36,000 messages a month against an allowance of 6,000,000,
one channel against 200, and a single long-lived subscriber connection against 200.

Encryption is **NIP-44 v2** (ChaCha20 + HMAC-SHA256, encrypt-then-MAC) — a published specification
with official test vectors, which the build verifies against. Two notes on why:

- The original design named XChaCha20-Poly1305. Electron's BoringSSL exposes no ChaCha cipher
  through `node:crypto` at all, and a reviewed spec with a conformance suite is a better target
  than an invented envelope regardless.
- TLS already protects the payload in transit, so this layer exists to keep it unreadable *to Ably*.
  It is asymmetric — encrypted to the receiver's public key — specifically so that extracting the
  client's credentials never yields the ability to decrypt anything.

---

## Wire schema

Versioned protobuf. `schema_version` bumps only for structural changes; adding a feature or
operation ID is not one.

```protobuf
syntax = "proto3";
package jobmonitor.telemetry.v1;

message TelemetryBatch {
  bytes  batch_id         = 1;   // 16 random bytes
  uint32 schema_version   = 2;
  bytes  installation_id  = 3;   // 16 bytes
  bytes  deployment_id    = 4;   // 16 bytes
  string app_version      = 5;
  uint32 platform         = 6;   // 1 win32, 2 darwin, 3 linux
  uint32 arch             = 7;   // 1 x64, 2 arm64
  string electron_version = 8;
  uint64 period_start_ms  = 9;
  uint64 period_end_ms    = 10;

  repeated FeatureUsage   features   = 11;
  repeated OperationUsage operations = 12;
  repeated UsageSummary   usage      = 13;
  repeated CrashRecord    crashes    = 14;

  uint32 dropped_records  = 15;   // evicted locally; keeps gaps visible
}

message FeatureUsage {
  uint32 feature_id = 1;
  uint32 count      = 2;
}

message OperationUsage {
  uint32 operation_id    = 1;
  uint32 count           = 2;
  uint64 duration_sum_ms = 3;
  uint32 duration_max_ms = 4;
  repeated uint32 buckets = 5 [packed = true];   // exactly 8
  repeated FailureCount failures = 6;
}

message FailureCount {
  uint32 error_category = 1;
  uint32 count          = 2;
}

message UsageSummary {
  uint64 bucket_start_ms    = 1;   // UTC hour
  uint32 app_starts         = 2;
  uint32 session_count      = 3;
  uint32 foreground_seconds = 4;
  uint32 running_seconds    = 5;
  uint32 clean_shutdowns    = 6;
  uint32 unclean_exits      = 7;
}

message CrashRecord {
  uint64 occurred_at_ms = 1;
  string app_version    = 2;
  uint32 source         = 3;
  string exception_type = 4;
  bytes  fingerprint    = 5;
  string stack          = 6;
  uint32 count          = 7;
}
```

The schema has exactly **five string fields** — `app_version`, `electron_version`, and the crash
record's `app_version`, `exception_type` and `stack`. A build-time test walks the generated
descriptor and fails if a `string` field is added outside that allowlist. That test, rather than any
regex, is the structural privacy guarantee: a numeric-only format cannot carry free text.

---

## Server side

An outbound-only pipeline. **There is no public ingestion endpoint**: the receiver holds an outbound
WebSocket to Ably and opens no listening socket at all — not even on loopback. Its health is a
file on disk.

```
size → signature → decrypt → decompress → parse → schema → privacy validation
     → dedupe check → durable write → dedupe insert → acknowledge
```

Validation rejects a whole batch for envelope problems (wrong `deployment_id`, malformed IDs,
implausible period, oversized payload, suspicious compression ratio) and drops a single record for
record-level problems, so one bad record cannot cost a batch's worth of good ones. Unknown feature
and operation IDs are dropped rather than stored.

On any validation failure the receiver logs the `batch_id`, the rule and the field name — **never
the value**. A privacy validator that logs the data it rejected is worse than no validator.

Storage is OpenObserve on a single small Azure VM, reachable only over Tailscale. Retention is
365 days for usage and crashes, 7 days for deduplication records. See `server/README.md` for the
runbook.
