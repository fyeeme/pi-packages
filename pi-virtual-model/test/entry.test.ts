import { describe, it, expect, vi } from "vitest";
import entry, {
	routeAuto,
	enforceTimezoneModel,
	beijingSecondsOfDay,
	targetModelId,
	IMAGE_PATH,
	hasImageContent,
	userMessageHasImages,
} from "../index.ts";

const PROVIDER = "zai-coding-cn";
const FLASH = { provider: PROVIDER, id: "glm-5.3-flash" };
const AUTO = { provider: PROVIDER, id: "glm-5.3-auto" };

/** Fake pi capturing the virtual-model registration and the event hooks. */
function assemble() {
	const registered: any[] = [];
	const hooks: Record<string, any> = {};
	const pi = {
		registerVirtualModel: (def: any) => registered.push(def),
		on: (name: string, handler: any) => (hooks[name] = handler),
		setModel: vi.fn(),
	};
	entry(pi as any);
	return { registered, hooks, pi };
}

describe("combined entry", () => {
	it("assembles both strategies: virtual model plus timezone hooks", () => {
		const { registered, hooks } = assemble();
		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ provider: PROVIDER, id: "glm-5.3-auto" });
		expect(Object.keys(hooks).sort()).toEqual(["before_agent_start", "session_start"]);
	});

	it("re-exports both strategy surfaces under stable names", () => {
		for (const fn of [routeAuto, enforceTimezoneModel, beijingSecondsOfDay, targetModelId, hasImageContent, userMessageHasImages]) {
			expect(typeof fn).toBe("function");
		}
		expect(IMAGE_PATH).toBeInstanceOf(RegExp);
	});
});

describe("strategy cooperation", () => {
	it("after the cutoff the timezone rule moves the session onto the virtual model, which then routes image messages to flash", () => {
		const { registered, pi } = assemble();
		const route = registered[0]!.route;

		const ctx: any = {
			// Pre-cutoff state: session currently on flash.
			model: FLASH,
			modelRegistry: { find: (_provider: string, id: string) => (id === AUTO.id ? AUTO : id === FLASH.id ? FLASH : undefined) },
			ui: { notify: vi.fn() },
		};

		// UTC 07:00 == Beijing 15:00 — past the 14:18 cutoff: the rule must
		// move the session onto the virtual glm-5.3-auto model.
		enforceTimezoneModel(pi as any, ctx, new Date(Date.UTC(2026, 9, 29, 7, 0, 0)));
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith(AUTO);

		// With the session on the virtual model, an image-bearing user message
		// routes to glm-5.3-flash through the registered route().
		const routed = route(
			{
				reason: "user",
				messages: [{ role: "user", content: "what is in /tmp/shot.png" }],
				thinkingLevel: "high",
			} as any,
			ctx,
		);
		expect(routed.model).toMatchObject({ id: "glm-5.3-flash" });
	});

	it("before the cutoff the timezone rule keeps the session on flash and image routing stays reachable via --tools", () => {
		const { registered, pi } = assemble();
		const ctx: any = {
			model: FLASH,
			modelRegistry: { find: (_provider: string, id: string) => (id === FLASH.id ? FLASH : AUTO) },
			ui: { notify: vi.fn() },
		};
		// UTC 05:00 == Beijing 13:00 — before the cutoff: no switch.
		enforceTimezoneModel(pi as any, ctx, new Date(Date.UTC(2026, 9, 29, 5, 0, 0)));
		expect(pi.setModel).not.toHaveBeenCalled();

		// The virtual model is registered regardless of the clock, so a host
		// that selects it manually still gets image routing.
		expect(registered[0]!.id).toBe("glm-5.3-auto");
	});
});
