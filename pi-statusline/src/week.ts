/**
 * Natural-week window helpers.
 *
 * Both DeepSeek (local session scan) and ZAI (backend usage API) derive their
 * weekly window from here, so the two providers always agree on the same
 * natural-week boundary — Monday 00:00 in the host's local timezone.
 *
 * Note: UTC was used previously; local timezone is now intentional so the
 * figures line up with how users perceive "this week".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Epoch ms of the start of the current natural week (this Monday 00:00 local).
 * `now` is overridable for testing.
 */
export function startOfCurrentWeekLocal(now: Date = new Date()): number {
	const dayOfWeek = now.getDay(); // 0=Sun .. 6=Sat
	const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
	return new Date(
		now.getFullYear(), now.getMonth(), now.getDate() - mondayOffset,
		0, 0, 0, 0,
	).getTime();
}

/** Epoch ms of the start of the next natural week (next Monday 00:00 local). */
export function startOfNextWeekLocal(now: Date = new Date()): number {
	return startOfCurrentWeekLocal(now) + 7 * DAY_MS;
}
