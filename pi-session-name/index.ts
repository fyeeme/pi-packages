/**
 * pi-session-name — auto-name pi sessions with a short LLM-generated title.
 *
 * The implementation lives in ./src/core.ts; this entry re-exports only the
 * documented public API (see README "API (for extension developers)") plus
 * the default extension factory. Internal helpers are not part of the
 * package surface.
 */
export {
	buildTitleMessages,
	normalizeSessionTitle,
	fallbackSessionTitle,
	buildTitleRequest,
	buildVerdictRequest,
	loadConfig,
	generateTitle,
} from "./src/core.ts";
export type { PromptStyle, SessionEntry, TitleRequest, SessionNameConfig } from "./src/core.ts";

import { sessionNameExtension } from "./src/core.ts";

export default sessionNameExtension;
