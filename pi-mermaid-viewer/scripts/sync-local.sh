#!/usr/bin/env bash
set -euo pipefail

# Sync the local working copy of pi-mermaid-viewer to the global pi extensions dir.
# Run after editing index.ts / README / CHANGELOG etc. so the globally installed
# extension picks up the changes on next pi restart.
#
# Usage:
#   packages/extensions/pi-mermaid-viewer/scripts/sync-local.sh

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/.pi/agent/extensions/pi-mermaid-viewer"

if [ ! -d "$DEST_DIR" ]; then
	echo "Destination does not exist: $DEST_DIR" >&2
	echo "Run first: pi install ~/.pi/agent/local/pi-mermaid-viewer" >&2
	exit 1
fi

FILES=(index.ts README.md LICENSE CHANGELOG.md package.json tsconfig.json)

for f in "${FILES[@]}"; do
	if [ ! -f "$SRC_DIR/$f" ]; then
		echo "Missing source file: $SRC_DIR/$f" >&2
		exit 1
	fi
	cp "$SRC_DIR/$f" "$DEST_DIR/$f"
	echo "  synced $f"
done

echo "Done. Restart pi to load the updated extension."
