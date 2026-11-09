/**
 * pi-timezone-model — pick the session model by wall-clock time.
 *
 * Peak hours: Monday-Friday 14:00:00-18:00:00 Beijing time (UTC+8).
 * During peak hours            -> zai-coding-cn/glm-5.3-flash
 * At any other time (weekends) -> zai-coding-cn/glm-5.3-auto
 *
 * Checked on session_start and before every agent run, so a session left
 * open across a window boundary switches on the next message. Manual /model
 * picks are overridden on the next prompt (both enabled models are governed
 * by the rule, so this is intentional).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "zai-coding-cn";
const FLASH_ID = "glm-5.3-flash";
const AUTO_ID = "glm-5.3-auto";

/** Peak window in seconds of day, Beijing time: Monday-Friday [14:00:00, 18:00:00). */
const FLASH_WINDOW_START = 14 * 3600;
const FLASH_WINDOW_END = 18 * 3600;

/** Seconds of day in Beijing time (UTC+8, no DST — plain offset is exact). */
export function beijingSecondsOfDay(now: Date): number {
	const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
	return shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds();
}

/** Day of week in Beijing time: 0=Sunday ... 6=Saturday. */
export function beijingDayOfWeek(now: Date): number {
	return new Date(now.getTime() + 8 * 3600 * 1000).getUTCDay();
}

export function targetModelId(now: Date): string {
	const day = beijingDayOfWeek(now);
	const seconds = beijingSecondsOfDay(now);
	const peak = day >= 1 && day <= 5 && seconds >= FLASH_WINDOW_START && seconds < FLASH_WINDOW_END;
	return peak ? FLASH_ID : AUTO_ID;
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
