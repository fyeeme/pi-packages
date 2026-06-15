# pi-mermaid-viewer

Render Mermaid diagrams found in the conversation as an HTML page opened in the default browser.

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install npm:pi-mermaid-viewer

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:pi-mermaid-viewer

# Pinned version — skipped by `pi update`
pi install npm:pi-mermaid-viewer@1.0.0

# Try it once without saving (current run only)
pi -e npm:pi-mermaid-viewer
```

### From GitHub

This extension lives in the [`pi-mono`](https://github.com/earendil-works/pi-mono) monorepo under `packages/extensions/pi-mermaid-viewer/`. Pi's git source clones a whole repository root (no subdirectory support), so choose the flow that matches your setup:

**Option A — monorepo checkout + local path** (works today):

```bash
git clone https://github.com/earendil-works/pi-mono
# Global install from the checked-out subdirectory
pi install ./pi-mono/packages/extensions/pi-mermaid-viewer
# Or project-local
pi install -l ./pi-mono/packages/extensions/pi-mermaid-viewer
```

**Option B — direct `git:` source** (requires a standalone repo for this package):

```bash
# HTTPS shorthand
pi install git:github.com/<owner>/pi-mermaid-viewer
# Pin to a tag or commit (skipped by `pi update`)
pi install git:github.com/<owner>/pi-mermaid-viewer@v1.0.0
# Raw URL form
pi install https://github.com/<owner>/pi-mermaid-viewer
```

See the Pi Packages guide on [pi.dev](https://pi.dev) for the full list of source types, scopes, and `pi update` behavior.

## Usage

Run `/mermaid` to collect all ````mermaid` code blocks from the conversation and open them in your browser.

### Features

- **Dark / Light / White** background themes
- **Zoom** controls (25% – 400%) with 1:1 reset
- **2x PNG export** for sharing
- **Split view** to inspect source alongside rendered diagram
- **Multi-diagram navigation** when the conversation contains multiple blocks
- **Emoji support** — emoji render natively via the browser's color font
- **Auto-quoting** of node labels with special characters (`?`, `@`, `<br/>`, `/`, etc.) that Mermaid cannot parse
- Opens immediately in your default browser — no local server required
