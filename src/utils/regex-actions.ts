import type { RegexAction } from "../types/regex-script";
import type { SandboxCaptureReplacement } from "./regex-sandbox";

export interface ResolvedRegexAction extends RegexAction {
  scriptId: string;
  instanceId: string;
}

function resolveCost(value: string, fallback: number): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveLimit(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const ACTION_ATTR_RE = /\b(?:data-regex-action|id)\s*=\s*(["'])(.*?)\1/i;
const OPEN_TAG_RE = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?\s*\/?>/g;

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function decorateRegexActionHtml(html: string, actions: ResolvedRegexAction[]): string {
  if (actions.length === 0 || !html.includes("<")) return html;
  const byId = new Map(actions.map((action) => [action.id, action]));
  const limits = actions
    .filter((action) => action.multi_select)
    .map((action) => resolveLimit(action.limit))
    .filter((limit): limit is number => limit !== null);
  const blockLimit = limits.length > 0 ? Math.min(...limits) : 0;

  return html.replace(OPEN_TAG_RE, (tag) => {
    if (/^<\//.test(tag) || /\bdata-lumiverse-regex-action\s*=/.test(tag)) return tag;
    const association = tag.match(ACTION_ATTR_RE)?.[2];
    if (!association) return tag;
    const action = byId.get(association);
    if (!action) return tag;

    const encoded = encodeURIComponent(JSON.stringify({
      ...action,
      cost: resolveCost(action.cost, 1),
      limit: blockLimit,
    }));
    const label = [action.title, action.subtitle].filter(Boolean).join(" — ");
    const attributes = [
      `data-lumiverse-regex-action="${encoded}"`,
      action.multi_select ? `data-lumiverse-regex-action-multi="true"` : "",
      `role="button"`,
      `tabindex="0"`,
      label ? `aria-label="${escapeHtmlAttribute(label)}"` : "",
      action.title ? `title="${escapeHtmlAttribute(action.title)}"` : "",
    ].filter(Boolean).join(" ");
    return tag.replace(/\s*\/>$/, ` ${attributes} />`).replace(/(?<!\/)\s*>$/, ` ${attributes}>`);
  });
}

/**
 * Resolve action templates with the exact same regex captures as the HTML
 * replacement, without exposing captures as raw HTML attributes.
 */
export function buildRegexActionCaptureTemplate(actions: RegexAction[]): {
  template: string;
  unpack: (replacement: string, scriptId: string, instanceId: string) => ResolvedRegexAction[];
} {
  const nonce = `\u0002LRA:${crypto.randomUUID()}:`;
  const markers = Array.from({ length: actions.length * 5 + 1 }, (_, index) => `${nonce}${index}\u0003`);
  let template = markers[0];
  for (let i = 0; i < actions.length; i++) {
    template += actions[i].title + markers[i * 5 + 1];
    template += actions[i].subtitle + markers[i * 5 + 2];
    template += actions[i].content + markers[i * 5 + 3];
    template += actions[i].cost + markers[i * 5 + 4];
    template += actions[i].limit + markers[i * 5 + 5];
  }

  return {
    template,
    unpack(replacement, scriptId, instanceId) {
      if (!replacement.startsWith(markers[0])) return [];
      let cursor = markers[0].length;
      const resolved: ResolvedRegexAction[] = [];
      for (let i = 0; i < actions.length; i++) {
        const titleEnd = replacement.indexOf(markers[i * 5 + 1], cursor);
        if (titleEnd < 0) return [];
        const title = replacement.slice(cursor, titleEnd);
        cursor = titleEnd + markers[i * 5 + 1].length;

        const subtitleEnd = replacement.indexOf(markers[i * 5 + 2], cursor);
        if (subtitleEnd < 0) return [];
        const subtitle = replacement.slice(cursor, subtitleEnd);
        cursor = subtitleEnd + markers[i * 5 + 2].length;

        const contentEnd = replacement.indexOf(markers[i * 5 + 3], cursor);
        if (contentEnd < 0) return [];
        const content = replacement.slice(cursor, contentEnd);
        cursor = contentEnd + markers[i * 5 + 3].length;

        const costEnd = replacement.indexOf(markers[i * 5 + 4], cursor);
        if (costEnd < 0) return [];
        const cost = replacement.slice(cursor, costEnd);
        cursor = costEnd + markers[i * 5 + 4].length;

        const limitEnd = replacement.indexOf(markers[i * 5 + 5], cursor);
        if (limitEnd < 0) return [];
        const limit = replacement.slice(cursor, limitEnd);
        cursor = limitEnd + markers[i * 5 + 5].length;
        resolved.push({ ...actions[i], title, subtitle, content, cost, limit, scriptId, instanceId });
      }
      return resolved;
    },
  };
}

export function decorateRegexActionReplacements(
  replacements: string[],
  actionMatches: SandboxCaptureReplacement[],
  unpack: (replacement: string, scriptId: string, instanceId: string) => ResolvedRegexAction[],
  scriptId: string,
): string[] {
  return replacements.map((replacement, index) => decorateRegexActionHtml(
    replacement,
    actionMatches[index]
      ? unpack(
          actionMatches[index].replacement,
          scriptId,
          `${scriptId}:${actionMatches[index].index}:${actionMatches[index].index + actionMatches[index].matchLength}`,
        )
      : [],
  ));
}
