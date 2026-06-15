# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2025-05-31

### Added

- Initial release
- Two-line footer: cwd + git branch (left) / model + thinking level (right), and token stats line
- Token usage: input, output, cache read/write, total per session
- Cost display with auto currency detection (¥ for DeepSeek, $ otherwise)
- DeepSeek account balance fetched on startup, cached 5 minutes
- Context window usage percentage and size
- Elapsed time and tokens/sec for last response
- MCP server connection count and tool count via `mcp:status` / `mcp:disconnect` events
- `/balance` command to force-refresh DeepSeek balance
- `/currency [auto|¥|$]` command to toggle cost currency
- `/status-debug` command to dump session stats to log file
