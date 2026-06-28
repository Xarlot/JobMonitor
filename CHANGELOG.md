# Changelog

All notable changes to **Job Monitor** are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

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
