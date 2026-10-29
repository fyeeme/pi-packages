import { describe, it, expect, vi } from "vitest";
import {
	IMAGE_PATH,
	hasImageContent,
	userMessageHasImages,
	routeAuto,
	default as virtualModelsExtension,
} from "../index.ts";

const PROVIDER = "zai-coding-cn";
const TEXT = { provider: PROVIDER, id: "glm-5.3" };
const FLASH = { provider: PROVIDER, id: "glm-5.3-flash" };

/** ExtensionContext stand-in: a live modelRegistry (find returns catalog entries). */
function mkCtx(models: unknown[] = [TEXT, FLASH]) {
	return {
		modelRegistry: {
			find: (provider: string, id: string) =>
				models.find((m: any) => m.provider === provider && m.id === id),
		},
		ui: { notify: vi.fn() },
	} as any;
}

/** ctx whose modelRegistry getter throws (ThinkRail stale-ctx case). */
function mkStaleCtx() {
	return {
		get modelRegistry() {
			throw new Error("ctx disposed");
		},
		ui: { notify: vi.fn() },
	} as any;
}

describe("IMAGE_PATH", () => {
	it("matches common image extensions in prose", () => {
		for (const text of ["see /tmp/shot.png", "~/a.JPG", "img (1).jpeg.", "shot.heic"]) {
			expect(IMAGE_PATH.test(text)).toBe(true);
		}
	});

	it("does not match plain text or non-image files", () => {
		for (const text of ["no files here", "script.ts", "data.json", "photo.pngw"]) {
			expect(IMAGE_PATH.test(text)).toBe(false);
		}
	});
});

describe("hasImageContent", () => {
	it("detects image blocks in user and toolResult messages", () => {
		expect(hasImageContent({ role: "user", content: [{ type: "image" }] } as any)).toBe(true);
		expect(hasImageContent({ role: "toolResult", content: [{ type: "image" }] } as any)).toBe(true);
	});

	it("ignores string content, plain text blocks, and other roles", () => {
		expect(hasImageContent({ role: "user", content: "path.png" } as any)).toBe(false);
		expect(hasImageContent({ role: "user", content: [{ type: "text", text: "x.png" }] } as any)).toBe(false);
		expect(hasImageContent({ role: "assistant", content: [] } as any)).toBe(false);
	});
});

describe("userMessageHasImages", () => {
	it("checks only the latest user message: image blocks or image paths in text", () => {
		const msgs: any[] = [
			{ role: "user", content: [{ type: "image" }] }, // old image does not count
			{ role: "assistant", content: [] },
			{ role: "user", content: "plain question" },
		];
		expect(userMessageHasImages(msgs)).toBe(false);
		msgs[2] = { role: "user", content: "what is in /tmp/shot.png" };
		expect(userMessageHasImages(msgs)).toBe(true);
		msgs[2] = { role: "user", content: [{ type: "text", text: "see ~/a.JPG" }] };
		expect(userMessageHasImages(msgs)).toBe(true);
	});

	it("returns false with no user messages", () => {
		expect(userMessageHasImages([{ role: "assistant", content: [] } as any])).toBe(false);
	});
});

describe("routeAuto", () => {
	it("routes a user message with images to flash, without images to text", () => {
		const withImg = { reason: "user", messages: [{ role: "user", content: [{ type: "image" }] }], thinkingLevel: "high" } as any;
		const plain = { reason: "user", messages: [{ role: "user", content: "hello" }], thinkingLevel: "high" } as any;
		expect(routeAuto(withImg, mkCtx()).model.id).toBe("glm-5.3-flash");
		expect(routeAuto(plain, mkCtx()).model.id).toBe("glm-5.3");
	});

	it("retries stay on the failed model with its thinking level", () => {
		const failed = { model: FLASH, thinkingLevel: "max" as const };
		const req = { reason: "retry", failed, messages: [], thinkingLevel: "high" as const } as any;
		const route = routeAuto(req, mkCtx());
		expect(route.model).toBe(FLASH);
		expect(route.thinkingLevel).toBe("max");
	});

	it("direct requests go to flash when any conversation message carries images", () => {
		const req = {
			reason: "direct",
			messages: [{ role: "user", content: "old text" }, { role: "toolResult", content: [{ type: "image" }] }],
			thinkingLevel: "high",
		} as any;
		expect(routeAuto(req, mkCtx()).model.id).toBe("glm-5.3-flash");
	});

	it("continuation switches to flash when a fresh image tool result arrived after the last assistant turn", () => {
		const req = {
			reason: "tool_result",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [] },
				{ role: "toolResult", content: [{ type: "image" }] },
			],
			thinkingLevel: "high",
		} as any;
		expect(routeAuto(req, mkCtx()).model.id).toBe("glm-5.3-flash");
	});

	it("continuation without new images stays on the model that answered the turn", () => {
		const previous = { model: TEXT, thinkingLevel: "high" as const };
		const req = {
			reason: "tool_result",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: [] },
				{ role: "toolResult", content: [{ type: "text", text: "done" }] },
			],
			previous,
			thinkingLevel: "high",
		} as any;
		const route = routeAuto(req, mkCtx());
		expect(route.model).toBe(TEXT);
		expect(route.thinkingLevel).toBe("high");
	});

	it("routes to text on a previous-less continuation without images", () => {
		const req = { reason: "tool_result", messages: [], thinkingLevel: "high" } as any;
		expect(routeAuto(req, mkCtx()).model.id).toBe("glm-5.3");
	});

	it("throws when a live ctx asks for a model missing from the catalog", () => {
		const req = { reason: "user", messages: [{ role: "user", content: "hi" }], thinkingLevel: "high" } as any;
		expect(() => routeAuto(req, mkCtx([]))).toThrow("not in the catalog");
	});

	it("a stale ctx still routes (cache or identity stub; dispatcher re-resolves)", () => {
		const req = { reason: "user", messages: [{ role: "user", content: "hi" }], thinkingLevel: "high" } as any;
		const route = routeAuto(req, mkStaleCtx());
		// Cache hit or identity-only stub — identity is all the dispatcher needs.
		expect(route.model).toMatchObject({ provider: PROVIDER, id: "glm-5.3" });
	});

	it("toasts on a model switch, not on direct requests or unchanged models", () => {
		// reason "direct": background request, always silent.
		const direct = { reason: "direct", messages: [{ role: "user", content: "hi" }], thinkingLevel: "high" } as any;
		const directCtx = mkCtx();
		routeAuto(direct, directCtx);
		expect(directCtx.ui.notify).not.toHaveBeenCalled();

		// reason "user" with a different previous model: "Switched to".
		const switched = {
			reason: "user",
			messages: [{ role: "user", content: "hi" }],
			thinkingLevel: "high",
			previous: { model: FLASH, thinkingLevel: "high" as const },
		} as any;
		const switchedCtx = mkCtx();
		routeAuto(switched, switchedCtx);
		expect(switchedCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Switched to glm-5.3"));

		// Same physical model as previous turn: silent.
		const unchanged = {
			reason: "user",
			messages: [{ role: "user", content: "hi" }],
			thinkingLevel: "high",
			previous: { model: TEXT, thinkingLevel: "high" as const },
		} as any;
		const unchangedCtx = mkCtx();
		routeAuto(unchanged, unchangedCtx);
		expect(unchangedCtx.ui.notify).not.toHaveBeenCalled();

		// First routed request without a previous: "Routed to".
		const first = { reason: "user", messages: [{ role: "user", content: "see a.png" }], thinkingLevel: "high" } as any;
		const firstCtx = mkCtx();
		routeAuto(first, firstCtx);
		expect(firstCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Routed to glm-5.3-flash"));
	});
});

describe("extension registration", () => {
	it("registers the glm-5.3-auto virtual model with routeAuto", () => {
		const calls: any[] = [];
		virtualModelsExtension({ registerVirtualModel: (def: any) => calls.push(def) } as any);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ provider: PROVIDER, id: "glm-5.3-auto" });
		expect(calls[0].route).toBe(routeAuto);
	});
});
