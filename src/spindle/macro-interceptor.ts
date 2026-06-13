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
  userId?: string | null;
  priority: number;
  handler: (ctx: MacroInterceptorCtx) => Promise<MacroInterceptorResult>;
}

const INTERCEPTOR_TIMEOUT_MS = 10_000;

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

  async run(ctx: MacroInterceptorCtx): Promise<MacroInterceptorRunResult> {
    let template = ctx.template;
    const touchedVars = new Set<string>();
    let volatile = false;
    let opaque = false;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== ctx.userId) continue;
      try {
        const next = await Promise.race([
          handler.handler({ ...ctx, template }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Macro interceptor from ${handler.extensionId} timed out (${INTERCEPTOR_TIMEOUT_MS / 1000}s)`
                  )
                ),
              INTERCEPTOR_TIMEOUT_MS
            )
          ),
        ]);
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
          `[Spindle] Macro interceptor error from ${handler.extensionId}:`,
          err
        );
      }
    }

    return { text: template, touchedVars: [...touchedVars], volatile, opaque };
  }

  get count(): number {
    return this.handlers.length;
  }
}

export const macroInterceptorChain = new MacroInterceptorChain();
