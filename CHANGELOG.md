# Changelog

All notable changes to **Job Monitor** are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [0.9.0]

A Settings overhaul plus a workflow picker that fills in a flow for you from the repo's recent runs.

### Added
- **Browse recent workflows** — the flow editor's workflow field now has a **Browse…** button that
  opens a dialog listing every workflow that ran in the repo **in the last 24 hours**, grouped by
  workflow × branch × trigger, showing each one's status, file, trigger event, branch and last-run
  time. **Search** by name/file and **filter** by trigger or branch; pick a row and the flow's name,
  workflow file, branch and event are filled in automatically. The full day is paged through (not
  just the newest 100 runs), and the list is ETag-cached so reopening is cheap.

### Changed
- **Settings is split into focused tabs** — **Token & login**, **Repository**, **Polling**, **Flows**,
  **Notifications**, and (desktop only) **Updates**. Previously the repository, polling, flows and
  updates settings were all stacked under one "Polling" tab.
- **Flow cards are tidier** — only **Name** and **Workflow** (with the new Browse button) show by
  default; owner/repo, branches, events, max-runs and the "hide when empty" filter now live under a
  collapsed **Additional settings** section.

### Fixed
- **Action-icon alignment** — the per-job icons under an expanded flow run (and the per-check icons
  under a PR) now line up with the run/PR row's icons instead of being inset by the nested table's
  padding; the remove-flow trash icon also aligns with its row.

## [0.8.0]

### Fixed
- **Creating/renaming a group now works in the desktop app.** It used `window.prompt`, which Electron
  doesn't implement (it silently returns null); replaced with an in-app input dialog (works in the
  browser too).
- **"Check for updates" no longer crashes the desktop app.** A missing `updateToken` declaration in
  the main process threw `ReferenceError: updateToken is not defined`.

### Changed
- When there are **no groups at all**, the lone "Ungrouped" header is hidden — flows just render one
  after another.

## [0.7.0]

### Added
- **Artifact downloads** — flow runs, pull requests and their Overview tiles now have an artifacts
  button that opens a dialog listing the run's artifacts (sorted by name, with sizes). Download one
  as its own `.zip`, or select several / **Download all** to get a single combined `.zip` with a
  folder per artifact. The list is fetched lazily (and ETag-cached) so it only costs a request when
  opened; expired artifacts are shown but disabled.
- **Desktop downloads panel** — in the Electron app, downloads no longer save automatically: a panel
  (top-right button, with an active-count badge) shows each download's progress and status, and you
  press **Save** to write it to the Downloads folder, with a "Show in folder" action and a completion
  toast (bottom-right). In the browser, the browser keeps handling downloads itself.

### Changed
- **Node ≥ 22.12 is now required** (the repo pins Node 24 in `.nvmrc`). It's enforced via `engines`
  + `engine-strict`, so `npm install` fails fast on older Node instead of breaking deep inside
  Electron's installer (`ERR_REQUIRE_ESM`); the `electron:*` scripts also run a `check-node`
  preflight.

### Fixed
- **Auto-update now works for the internal app repo.** electron-updater read the release feed
  anonymously and got a 404 (the repo is internal). The desktop app now authenticates the updater
  with your GitHub token (passed from the renderer after unlock, never persisted), and picks up the
  published pre-releases. _Requires one manual update to a build that includes this fix._
- Dialogs use a thin, subtle scrollbar instead of the chunky default, and the artifacts dialog row
  no longer changes height when a download starts.

## [0.6.0]

A big dashboard-organization update: flow groups, drag-and-drop, a theme switcher, and a dedicated
full-screen Settings screen.

### Added
- **Flow groups** — organize flows into named groups in both **Overview** and the **Flows** tab.
  Drag flows between groups and reorder them, with a clear drop indicator showing where they'll
  land. Collapse a group — the collapsed header shows a status tally (✅ passed · 🟡 in progress ·
  ❌ failed). Group layout and membership persist locally across restarts.
- **Export / import board** — export the whole layout (groups + flow order) as JSON and move it
  between machines in a single file. Import replaces the current board. Your token and credentials
  are **not** included in the export.
- **Collapsible flow cards** — collapse a card into a thin strip; "accordion" behavior means
  expanding one collapses the others. Drag-and-drop reordering with a visible drop panel. Expanded
  state and position are remembered.
- **Theme switcher** — an icon-only button in the header cycles 🖥️ auto → ☀️ light → 🌙 dark. The
  dark theme uses GitHub's softer **dark dimmed** palette. Your choice is persisted.

### Changed
- **Settings** moved out of the navigation — it now opens **full-screen** from the gear icon in the
  top-right corner.
