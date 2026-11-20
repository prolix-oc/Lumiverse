import type { MacroEnv } from "../macros/types";

export type MacroInterceptorPhase =
  | "prompt"
  | "display"
  | "response"
  | "other";

export interface MacroInterceptorEnv {
  readonly commit: boolean;
  readonly names: MacroEnv["names"];
  readonly character: MacroEnv["character"];
  readonly chat: MacroEnv["chat"];
  readonly system: MacroEnv["system"];
  readonly variables: {
    readonly local: Record<string, string>;
    readonly global: Record<string, string>;
    readonly chat: Record<string, string>;
  };
  readonly dynamicMacros: Record<string, string>;
  readonly extra: Record<string, unknown>;
}

export interface MacroInterceptorCtx {
  readonly template: string;
  readonly env: MacroInterceptorEnv;
  readonly commit: boolean;
  readonly phase: MacroInterceptorPhase;
  readonly sourceHint?: string;
  readonly sourceOwner?: { readonly extensionIdentifier: string };
  readonly userId?: string;
}

export interface MacroInterceptorRichResult {
  text: string;
  touchedVars?: readonly string[];
  volatile?: boolean;
}

export type MacroInterceptorResult = string | MacroInterceptorRichResult | void;

export interface MacroInterceptorRunResult {
  text: string;
  touchedVars: readonly string[];
  volatile: boolean;
  opaque: boolean;
}

export interface MacroInterceptor {
  extensionId: string;
  extensionIdentifier?: string;
  handlesOwnedSources?: boolean;
  userId?: string | null;
  priority: number;
  handler: (ctx: MacroInterceptorCtx) => Promise<MacroInterceptorResult>;
}

class MacroInterceptorChain {
  private handlers: MacroInterceptor[] = [];

  register(handler: MacroInterceptor): () => void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  unregisterByExtension(extensionId: string): void {
    this.handlers = this.handlers.filter((h) => h.extensionId !== extensionId);
  }

  ownsMessageSource(extensions: Record<string, any>, userId: string | undefined): boolean {
    return this.handlers.some((h) => h.handlesOwnedSources && h.extensionIdentifier
      && (!h.userId || h.userId === userId)
      && extensions[h.extensionIdentifier]?.display_owner === true);
  }

  async runOwned(ctx: MacroInterceptorCtx): Promise<MacroInterceptorRunResult | undefined> {
    const handler = this.handlers.find((h) => h.handlesOwnedSources
      && h.extensionIdentifier === ctx.sourceOwner?.extensionIdentifier
      && (!h.userId || h.userId === ctx.userId));
    if (!handler) return undefined;
    const result = await handler.handler(ctx);
    if (typeof result === "string") {
      return { text: result, touchedVars: [], volatile: false, opaque: true };
    }
    if (!result || typeof result.text !== "string") {
      throw new OwnedMacroResultError(handler.extensionIdentifier!);
    }
    return { text: result.text, touchedVars: result.touchedVars ?? [], volatile: result.volatile === true, opaque: false };
  }

  async run(ctx: MacroInterceptorCtx): Promise<MacroInterceptorRunResult> {
    let template = ctx.template;
    const touchedVars = new Set<string>();
    let volatile = false;
    let opaque = false;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== ctx.userId) continue;
      try {
        const next = await handler.handler({ ...ctx, template });
        if (typeof next === "string") {
          if (next !== template) {
            template = next;
            opaque = true;
          }
        } else if (
          next &&
          typeof next === "object" &&
          typeof next.text === "string"
        ) {
          if (next.text !== template) template = next.text;
          if (next.touchedVars) {
            for (const v of next.touchedVars) touchedVars.add(v);
          }
          if (next.volatile) volatile = true;
        }
      } catch (err) {
        console.error(
          `[Spindle] Macro interceptor error from ${handler.extensionId}: ${err instanceof Error ? err.message : String(err)}`
        );
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
      }
    }

    return { text: template, touchedVars: [...touchedVars], volatile, opaque };
  }

  get count(): number {
    return this.handlers.length;
  }
}

export class OwnedMacroResultError extends Error {
  constructor(identifier: string) {
    super(`Macro source owner ${identifier} returned no result`);
    this.name = "OwnedMacroResultError";
  }
}

export const macroInterceptorChain = new MacroInterceptorChain();
