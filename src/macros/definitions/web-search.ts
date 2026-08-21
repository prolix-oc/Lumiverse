import { INLINE_WEB_SEARCH_CONTEXT_SLOT_MARKER } from "../../services/inline-web-search";
import { registry } from "../MacroRegistry";

/** Macros used to place context returned by the primary model's web_search tool. */
export function registerWebSearchMacros(): void {
  registry.registerMacro({
    builtIn: true,
    name: "webSearchContext",
    aliases: ["web_search_context"],
    category: "Web Search",
    description: "Placement slot for results from a primary-generation web search. Empty unless the model calls web_search; otherwise uses the current prompt block's role and position.",
    returnType: "string",
    handler: (ctx) => {
      // This macro is placement-only. Do not let a chat message, World Info
      // entry, or other unscoped content turn into a later prompt injection.
      return ctx.env.promptBlock
        ? INLINE_WEB_SEARCH_CONTEXT_SLOT_MARKER
        : "";
    },
  });
}
