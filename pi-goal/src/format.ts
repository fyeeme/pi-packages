/**
 * pi-goal — number/duration formatting.
 *
 * `formatNumber` ported verbatim from oh-my-pi
 * `packages/utils/src/format.ts` (compact K/M/B display used by the goal tool
 * renderer and status line). `formatDuration` ported from omp
 * `slash-commands/helpers/format.ts`.
 */

export function formatNumber(n: number): string {
	if (n < 1_000) return n.toString();
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}
