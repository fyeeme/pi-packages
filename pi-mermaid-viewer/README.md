# pi-mermaid-viewer

Render Mermaid diagrams found in the conversation as an HTML page opened in the default browser.

### 与 pi 0.84.0 内置 TUI mermaid 的区别

pi 0.84.0 起内置在终端内（TUI）渲染 Mermaid（`markdown.mermaid` 设置，默认 `streaming`）——适合**终端内速览**。本扩展与之**不是替代关系**，而是互补：

| | 本扩展（pi-mermaid-viewer） | pi 内置 TUI mermaid |
|---|---|---|
| 查看方式 | 浏览器打开 HTML 页面 | 终端内联预览 |
| 导出 | PNG / SVG 下载 | 无 |
| 多图 | 多图 tab 导航 | 逐块内联 |
| 解析失败 | try-first 修复器（仅当 Mermaid 解析失败时自动引号修复裸标签） | 直接显示解析错误 |
| 适用场景 | 需要检查/导出/分享图时 | 对话中快速扫一眼 |

两者可以共存：内置预览用于日常速览，需要细看或导出时再跑 `/mermaid`。

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
