/**
 * pi-timezone-model — pick the session model by wall-clock time.
 *
 * Beijing time (UTC+8) < 14:18:00  -> zai-coding-cn/glm-5.3-flash
 * Beijing time (UTC+8) >= 14:18:00 -> zai-coding-cn/glm-5.3-auto
 *
 * Checked on session_start and before every agent run, so a session left
 * open across the cutoff switches on the next message. Manual /model picks
 * are overridden on the next prompt (both enabled models are governed by
 * the rule, so this is intentional).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "zai-coding-cn";
const FLASH_ID = "glm-5.3-flash";
const AUTO_ID = "glm-5.3-auto";

/** Cutoff in seconds of day, Beijing time: 14:18:00 */
const CUTOFF_SECONDS = 14 * 3600 + 18 * 60;

/** Seconds of day in Beijing time (UTC+8, no DST — plain offset is exact). */
export function beijingSecondsOfDay(now: Date): number {
	const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
	return shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
}

export function targetModelId(now: Date): string {
	return beijingSecondsOfDay(now) < CUTOFF_SECONDS ? FLASH_ID : AUTO_ID;
}

export async function enforce(pi: ExtensionAPI, ctx: ExtensionContext, now = new Date()): Promise<void> {
	const targetId = targetModelId(now);
	const current = ctx.model;
	if (current && current.provider === PROVIDER && current.id === targetId) return;

	const target = ctx.modelRegistry.find(PROVIDER, targetId);
	if (!target) {
		ctx.ui.notify(`pi-timezone-model: model not found: ${PROVIDER}/${targetId}`, "warning");
		return;
	}
	const ok = await pi.setModel(target);
	if (ok) {
		ctx.ui.notify(`pi-timezone-model: switched to ${targetId}`, "info");
	}
}

export function timezoneModelExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await enforce(pi, ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await enforce(pi, ctx);
	});
}
