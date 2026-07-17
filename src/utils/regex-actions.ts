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
  const fieldCount = actions.reduce((count, action) => (
    count + 5 + (action.effects ?? []).filter((effect) => effect.type !== "fork").length
  ), 0);
  const markers = Array.from({ length: fieldCount + 1 }, (_, index) => `${nonce}${index}\u0003`);
  let template = markers[0];
  let templateMarker = 1;
  for (const action of actions) {
    for (const value of [action.title, action.subtitle, action.content, action.cost, action.limit]) {
      template += value + markers[templateMarker++];
    }
    for (const effect of action.effects ?? []) {
      if (effect.type === "set_state") template += effect.value + markers[templateMarker++];
      else if (effect.type === "draft") template += effect.content + markers[templateMarker++];
    }
  }

  return {
    template,
    unpack(replacement, scriptId, instanceId) {
      if (!replacement.startsWith(markers[0])) return [];
      let cursor = markers[0].length;
      const resolved: ResolvedRegexAction[] = [];
      let markerIndex = 1;
      const readField = (): string | null => {
        const marker = markers[markerIndex++];
        const end = replacement.indexOf(marker, cursor);
        if (end < 0) return null;
        const value = replacement.slice(cursor, end);
        cursor = end + marker.length;
        return value;
      };
      for (const action of actions) {
        const fields = Array.from({ length: 5 }, readField);
        if (fields.some((field) => field === null)) return [];
        const effects = [] as NonNullable<RegexAction["effects"]>;
        for (const effect of action.effects ?? []) {
          if (effect.type === "fork") {
            effects.push(effect);
            continue;
          }
          const value = readField();
          if (value === null) return [];
          if (effect.type === "set_state") effects.push({ ...effect, value });
          else effects.push({ ...effect, content: value });
        }
        const [title, subtitle, content, cost, limit] = fields as string[];
        resolved.push({
          ...action,
          title,
          subtitle,
          content,
          cost,
          limit,
          ...(effects.length > 0 ? { effects } : {}),
          scriptId,
          instanceId,
        });
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
