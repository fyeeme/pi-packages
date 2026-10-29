/**
 * Auto image routing - a virtual model that switches by image presence.
 *
 * Registers `zai-coding-cn/auto`:
 *
 * - A user message that carries images (pasted/attached image blocks, or image file
 *   paths in the text) goes to glm-5.3-flash, which reads images natively.
 * - Any other user message goes to glm-5.3 (text only).
 * - Tool follow-ups and retries stay on the model that handled the turn, so prompt
 *   caches and thinking signatures stay valid. Exception: when a new tool result
 *   delivers an image while glm-5.3 is answering, the next request switches to
 *   glm-5.3-flash, because glm-5.3 would reduce the image to a placeholder.
 * - Requests outside the agent loop (e.g. compaction summaries) go to flash when
 *   the conversation contains images, else to glm-5.3.
 *
 * ThinkRail note (stale extension ctx, JetBrains/thinkrail#758):
 * ThinkRail shares one model runtime across all chat sessions and keeps virtual
 * model registrations alive after the registering session is disposed, so route()
 * can be dispatched with an invalidated ctx whose property getters throw. This
 * extension therefore never depends on a live ctx:
 *
 * - Physical Model objects are cached on the first successful lookup. The
 *   dispatcher re-resolves the target by provider/id after route() returns, so a
 *   cached Model object only carries identity, never stale catalog data.
 * - Retries and continuations reuse `request.failed.model` / `request.previous.model`,
 *   which the dispatcher resolves without the extension ctx.
 * - The switch toast is best-effort: it is dropped when the ctx is stale.
 * - Cold start with a stale ctx: route() returns an identity-only stub
 *   `{provider, id}`. The dispatcher (ModelRegistry.resolveModel) reads only
 *   provider/id from the routed model, then re-resolves and validates the
 *   physical model itself (existence + credentials), so routing still works
 *   before any live lookup has populated the cache.
 *
 * Usage: select `zai-coding-cn/glm-5.3-auto` in /model (add it to `enabledModels`).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "zai-coding-cn";
const TEXT_MODEL = "glm-5.3";
const IMAGE_MODEL = "glm-5.3-flash";

/** Image file path in message text: "see /tmp/shot.png", "~/a.JPG", "img (1).jpeg." */
export const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?|avif|heic)\b/i;

type RequestMessage = ModelRouteRequest["messages"][number];

/** Models resolved while the ctx was live; identity only, re-resolved by the dispatcher. */
const modelCache = new Map<string, ModelRoute["model"]>();

function findModel(ctx: ExtensionContext, id: string): ModelRoute["model"] {
	let registry: ExtensionContext["modelRegistry"] | undefined;
	try {
		registry = ctx.modelRegistry; // Getter throws when the ctx is stale.
	} catch {
		registry = undefined;
	}
	if (registry) {
		const model = registry.find(PROVIDER, id);
		if (!model) throw new Error(`Model ${PROVIDER}/${id} is not in the catalog`);
		modelCache.set(id, model);
		return model;
	}
	const cached = modelCache.get(id);
	if (cached) return cached;
	// Stale ctx and nothing cached yet (cold start): return an identity-only stub.
	// The dispatcher re-resolves the physical model by provider/id and validates
	// existence + credentials itself, so the stub never reaches a provider call.
	return { provider: PROVIDER, id } as ModelRoute["model"];
}

function routeTo(request: ModelRouteRequest, ctx: ExtensionContext, id: string): ModelRoute {
	const model = findModel(ctx, id);
	notifySwitch(request, ctx, model);
	return { model, thinkingLevel: request.thinkingLevel };
}

/** Toast when the dispatched physical model is first chosen or changes; background requests stay silent. */
function notifySwitch(request: ModelRouteRequest, ctx: ExtensionContext, model: ModelRoute["model"]): void {
	if (request.reason === "direct") return;
	const previous = request.previous?.model;
	if (previous?.id === model.id) return;
	const verb = previous ? "Switched to" : "Routed to";
	try {
		ctx.ui.notify(`${verb} ${model.id} (thinking: ${request.thinkingLevel})`);
	} catch {
		// Stale ctx (ThinkRail): drop the toast, keep routing.
	}
}

/** Whether a message carries image blocks: attached images or image tool results. */
export function hasImageContent(message: RequestMessage): boolean {
	if (message.role === "user") {
		return typeof message.content !== "string" && message.content.some((b) => b.type === "image");
	}
	if (message.role === "toolResult") {
		return message.content.some((b) => b.type === "image");
	}
	return false;
}

/** Whether the latest user message references images: image blocks or image paths in text. */
export function userMessageHasImages(messages: readonly RequestMessage[]): boolean {
	const lastUser = messages.filter((m) => m.role === "user").at(-1);
	if (!lastUser) return false;
	if (typeof lastUser.content === "string") return IMAGE_PATH.test(lastUser.content);
	return lastUser.content.some(
		(block) => block.type === "image" || (block.type === "text" && IMAGE_PATH.test(block.text)),
	);
}

/** The routing decision for the registered `glm-5.3-auto` virtual model. */
export function routeAuto(request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute {
	// Retries stay on the failed model to keep caches and signatures valid.
	if (request.reason === "retry" && request.failed) {
		return {
			model: request.failed.model,
			thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
		};
	}
	// New user message: route by whether it references images.
	if (request.reason === "user") {
		return routeTo(request, ctx, userMessageHasImages(request.messages) ? IMAGE_MODEL : TEXT_MODEL);
	}
	// Outside the agent loop: flash still sees conversation images natively.
	if (request.reason === "direct") {
		return routeTo(request, ctx, request.messages.some(hasImageContent) ? IMAGE_MODEL : TEXT_MODEL);
	}
	// Continuation: a fresh image tool result needs a model that can see it.
	const lastAssistant = request.messages.findLastIndex((m) => m.role === "assistant");
	const freshImage = request.messages.slice(lastAssistant + 1).some(hasImageContent);
	if (freshImage) return routeTo(request, ctx, IMAGE_MODEL);
	// Otherwise stay on the model that answered this turn.
	if (request.previous) {
		return {
			model: request.previous.model,
			thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
		};
	}
	return routeTo(request, ctx, TEXT_MODEL);
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel({
		provider: PROVIDER,
		id: "glm-5.3-auto",
		name: "glm-5.3-auto (Image)",
		thinkingLevels: ["high", "max"],
		// Shared by glm-5.3 and glm-5.3-flash; shown before the first response.
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		route: routeAuto,
	});
}
