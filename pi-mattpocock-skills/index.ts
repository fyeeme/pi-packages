import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBootstrap } from "./src/bootstrap.ts";
import { registerCommands } from "./src/commands.ts";

export default function mattpocockSkillsExtension(pi: ExtensionAPI): void {
	registerCommands(pi);
	if (process.env.MATTPOCOCK_ENABLE_BOOTSTRAP === "1") {
		registerBootstrap(pi);
	}
}
