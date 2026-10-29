/**
 * pi-virtual-model — model selection routing for pi.
 *
 * Two cooperating strategies in one extension:
 *
 * 1. Virtual model `zai-coding-cn/glm-5.3-auto` (src/virtual-model.ts):
 *    routes by image presence — glm-5.3-flash for image messages, glm-5.3
 *    for text. Retries and continuations stay on the turn's model.
 * 2. Wall-clock switching (src/timezone.ts): before 14:18:00 Beijing time
 *    the session runs on glm-5.3-flash, from 14:18:00 on the virtual
 *    glm-5.3-auto takes over. Enforced on session_start and before every
 *    agent run.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { timezoneModelExtension } from "./src/timezone.ts";
import { virtualModelExtension } from "./src/virtual-model.ts";

export {
	beijingSecondsOfDay,
	targetModelId,
	enforce as enforceTimezoneModel,
} from "./src/timezone.ts";
export {
	IMAGE_PATH,
	hasImageContent,
	userMessageHasImages,
	routeAuto,
} from "./src/virtual-model.ts";

export default function virtualModelExtensionEntry(pi: ExtensionAPI) {
	virtualModelExtension(pi);
	timezoneModelExtension(pi);
}
