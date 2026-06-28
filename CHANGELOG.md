# Changelog

All notable changes to **Job Monitor** are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[semantic versioning](https://semver.org/).

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
