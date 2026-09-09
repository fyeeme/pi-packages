import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Anchor runtime dependency resolution to this package's own devDependencies
// (the pinned npm copies under node_modules/). Without this, files imported
// from elsewhere in the monorepo — the parity conformance suite imports the
// reference example under packages/coding-agent/examples — resolve
// `@earendil-works/pi-coding-agent` through the workspace link to that
// package's UNBUILT dist/ and fail. The copies here are the exact versions
// this package pins, so every test (including the conformance suite) shares
// one dependency closure.
const pkgNodeModules = join(dirname(fileURLToPath(import.meta.url)), "node_modules");

const alias = ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"].map((name) => ({
	find: new RegExp(`^@earendil-works/${name}$`),
	replacement: join(pkgNodeModules, "@earendil-works", name),
}));

export default defineConfig({
	resolve: { alias },
	test: { environment: "node" },
});
