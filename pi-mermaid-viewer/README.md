# pi-mermaid-viewer

Render Mermaid diagrams found in the conversation as an HTML page opened in the default browser.

## Install

Requires the [pi](https://pi.dev) CLI.

### From npm (recommended)

```bash
# Global (user) install — available in every project
pi install npm:@fyeeme/pi-mermaid-viewer

# Project-local — written to .pi/settings.json, shareable with your team
pi install -l npm:@fyeeme/pi-mermaid-viewer

# Pinned version — skipped by `pi update`
pi install npm:@fyeeme/pi-mermaid-viewer@1.0.0

# Try it once without saving (current run only)
pi -e npm:@fyeeme/pi-mermaid-viewer
```

### From GitHub

Source: [`fyeeme/pi-packages`](https://github.com/fyeeme/pi-packages).

```bash
# HTTPS shorthand
pi install git:github.com/fyeeme/pi-packages
# Pin to a tag or commit (skipped by `pi update`)
pi install git:github.com/fyeeme/pi-packages@v1.0.0
# Raw URL form
pi install https://github.com/fyeeme/pi-packages
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
