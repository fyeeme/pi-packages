import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "./src/bootstrap.ts";
import { registerCommands } from "./src/commands.ts";
import { isBootstrapEnabled, readPrefs, writePrefs } from "./src/prefs.ts";

export default function mattpocockSkillsExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	registerMattBootstrapCommand(pi);
	if (isBootstrapEnabled()) {
		registerBootstrap(pi);
	}
}

/**
 * Parse an explicit on/off argument for `/matt-bootstrap`; returns undefined
 * for anything unrecognized (caller falls back to toggling the persisted value).
 */
function parseBootstrapArg(arg: string): boolean | undefined {
	if (arg === "on" || arg === "1" || arg === "true") return true;
	if (arg === "off" || arg === "0" || arg === "false") return false;
	return undefined;
}

/**
 * `/matt-bootstrap [on|off]` — toggle (or set) the persisted ask-matt bootstrap
 * guidance. The new value applies on the next session startup, since bootstrap
 * handlers register once at extension load (design D2: next-session semantics).
 * `MATTPOCOCK_ENABLE_BOOTSTRAP=1` remains a one-shot enable override for the
 * current process and is not affected by this command.
 */
function registerMattBootstrapCommand(pi: ExtensionAPI): void {
	pi.registerCommand("matt-bootstrap", {
		description: "Toggle ask-matt bootstrap guidance on/off (persisted; applies next session).",
		async handler(args, ctx) {
			const arg = args.trim().toLowerCase();
			const parsed = arg === "" ? undefined : parseBootstrapArg(arg);
			if (arg !== "" && parsed === undefined) {
				ctx.ui.notify("Usage: /matt-bootstrap [on|off] (no arg toggles)", "warning");
				return;
			}
			const next = parsed ?? !readPrefs().bootstrap;
			try {
				writePrefs({ bootstrap: next });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`mattpocock bootstrap: failed to persist prefs (${msg})`, "warning");
				return;
			}
			const envNote =
				process.env.MATTPOCOCK_ENABLE_BOOTSTRAP === "1" && !next
					? " (MATTPOCOCK_ENABLE_BOOTSTRAP=1 still enables it this session)"
					: "";
			ctx.ui.notify(
				`mattpocock bootstrap: ${next ? "on" : "off"}${envNote} (applies next session)`,
				"info",
			);
		},
	});
}
