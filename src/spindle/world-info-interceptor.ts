import type { WorldBookEntry } from "../types/world-book";
import type { BookSource } from "../services/world-info-sources.service";
import type { WorldInfoInterceptorPlacementDTO } from "lumiverse-spindle-types";

export type { WorldInfoInterceptorPlacementDTO } from "lumiverse-spindle-types";

export interface WorldInfoInterceptorEntryDTO {
  readonly id: string;
  readonly world_book_id: string;
  readonly comment: string;
  readonly disabled: boolean;
  readonly constant: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly key: readonly string[];
  readonly keysecondary: readonly string[];
  readonly position: number;
  readonly depth: number;
  readonly role: string | null;
  readonly priority: number;
  readonly probability: number;
  readonly use_probability: boolean;
  readonly content: string;
  readonly automation_id: string | null;
  readonly selective: boolean;
  readonly selective_logic: number;
  readonly group_name: string;
  readonly group_override: boolean;
  readonly group_weight: number;
  readonly match_whole_words: boolean;
  readonly case_sensitive: boolean;
  readonly use_regex: boolean;
  readonly prevent_recursion: boolean;
  readonly exclude_recursion: boolean;
  readonly delay_until_recursion: boolean;
  readonly exclude_greeting: boolean;
  readonly scan_depth: number | null;
  readonly order_value: number;
  readonly sticky: number;
  readonly cooldown: number;
  readonly delay: number;
  readonly placement?: WorldInfoInterceptorPlacementDTO;
  readonly outputOrder?: "selection" | "insertion";
  readonly book_source?: BookSource;
}

export interface WorldInfoInterceptorMessageDTO {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  readonly is_user: boolean;
  readonly is_greeting: boolean;
  readonly greeting_index?: number;
  readonly swipe_id: number;
  readonly index_in_chat: number;
}

export interface WorldInfoActivationSettingsDTO {
  /** Default entry scan depth, or null to scan all available messages. */
  readonly globalScanDepth: number | null;
  readonly maxRecursionPasses: number;
}

export interface WorldInfoActivationOverridesDTO {
  readonly disableRecursion?: true;
}

export interface WorldInfoInterceptorCtxDTO {
  readonly chatId: string;
  readonly characterId: string;
  readonly userId?: string;
  readonly entries: readonly WorldInfoInterceptorEntryDTO[];
  readonly messages: readonly WorldInfoInterceptorMessageDTO[];
  readonly chatTurn: number;
  readonly chatMetadata: Readonly<Record<string, unknown>>;
  readonly activationSettings: WorldInfoActivationSettingsDTO;
}

export interface WorldInfoInterceptorMutationDTO {
  readonly id: string;
  /** Prompt-local replacement used for final insertion. */
  readonly content?: string;
  /** Prompt-local alternate used only by host selection and token accounting. */
  readonly selectionContent?: string;
  /** Prompt-local placement relative to the selected chat history. */
  readonly placement?: WorldInfoInterceptorPlacementDTO;
  /** Prompt-local output ordering; never changes activation or budget competition. */
  readonly outputOrder?: "selection" | "insertion";
}

export interface WorldInfoInterceptorResultDTO {
  readonly disabled?: readonly string[];
  readonly enabled?: readonly string[];
  readonly forced?: readonly string[];
  readonly mutated?: readonly WorldInfoInterceptorMutationDTO[];
  readonly captured?: readonly string[];
  readonly activationOverrides?: WorldInfoActivationOverridesDTO;
}

export interface WorldInfoInterceptorChainResult {
  readonly entries: WorldBookEntry[];
  readonly captureRequests: Map<string, Set<string>>;
  readonly activationOverrides: WorldInfoActivationOverridesDTO;
  readonly selectionContentByEntryId: ReadonlyMap<string, string>;
  readonly placementByEntryId: ReadonlyMap<
    string,
    WorldInfoInterceptorPlacementDTO
  >;
  readonly insertionOrderByEntryId: ReadonlyMap<string, string>;
}

function normalizePlacement(
  value: unknown,
): WorldInfoInterceptorPlacementDTO | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "chat_depth" ||
    (candidate.role !== "system" &&
      candidate.role !== "user" &&
      candidate.role !== "assistant") ||
    (candidate.direction !== "from_start" &&
      candidate.direction !== "from_end") ||
    typeof candidate.depth !== "number" ||
    !Number.isFinite(candidate.depth) ||
    !Number.isInteger(candidate.depth) ||
    candidate.depth < 0
  ) {
    return null;
  }
  return {
    type: "chat_depth",
    role: candidate.role,
    depth: candidate.depth,
    direction: candidate.direction,
  };
}

export interface WorldInfoInterceptor {
  extensionId: string;
  userId?: string | null;
  priority: number;
  handler: (
    ctx: WorldInfoInterceptorCtxDTO
  ) => Promise<WorldInfoInterceptorResultDTO | void>;
}

export class WorldInfoInterceptorChain {
  private handlers: WorldInfoInterceptor[] = [];

  register(handler: WorldInfoInterceptor): () => void {
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

  async run(
    entries: readonly WorldBookEntry[],
    ctx: Omit<WorldInfoInterceptorCtxDTO, "entries">,
    userId?: string | null,
    bookSourceMap?: ReadonlyMap<string, BookSource>
  ): Promise<WorldInfoInterceptorChainResult> {
    if (this.handlers.length === 0) {
      return {
        entries: [...entries],
        captureRequests: new Map(),
        activationOverrides: {},
        selectionContentByEntryId: new Map(),
        placementByEntryId: new Map(),
        insertionOrderByEntryId: new Map(),
      };
    }

    const placementByEntryId = new Map<
      string,
      WorldInfoInterceptorPlacementDTO
    >();
    const insertionOrderByEntryId = new Map<string, string>();
    const buildDto = (
      src: readonly WorldBookEntry[]
    ): WorldInfoInterceptorEntryDTO[] =>
      src.map((e) => ({
        id: e.id,
        world_book_id: e.world_book_id,
        comment: e.comment,
        disabled: e.disabled,
        constant: e.constant,
        extensions: e.extensions ?? {},
        key: e.key,
        keysecondary: e.keysecondary,
        position: e.position,
        depth: e.depth,
        role: e.role,
        priority: e.priority,
        probability: e.probability,
        use_probability: e.use_probability,
        content: e.content,
        automation_id: e.automation_id,
        selective: e.selective,
        selective_logic: e.selective_logic,
        group_name: e.group_name,
        group_override: e.group_override,
        group_weight: e.group_weight,
        match_whole_words: e.match_whole_words,
        case_sensitive: e.case_sensitive,
        use_regex: e.use_regex,
        prevent_recursion: e.prevent_recursion,
        exclude_recursion: e.exclude_recursion,
        delay_until_recursion: e.delay_until_recursion,
        exclude_greeting: e.exclude_greeting,
        scan_depth: e.scan_depth,
        order_value: e.order_value,
        sticky: e.sticky,
        cooldown: e.cooldown,
        delay: e.delay,
        ...(placementByEntryId.has(e.id)
          ? { placement: placementByEntryId.get(e.id)! }
          : {}),
        ...(insertionOrderByEntryId.has(e.id)
          ? { outputOrder: "insertion" as const }
          : {}),
        book_source: bookSourceMap?.get(e.world_book_id),
      }));

    const disabledByChain = new Set<string>();
    const enabledByChain = new Set<string>();
    const forcedByChain = new Set<string>();
    const contentOverrides = new Map<string, string>();
    const captureRequests = new Map<string, Set<string>>();
    const candidateIds = new Set(entries.map((entry) => entry.id));
    const selectionContentByEntryId = new Map<string, string>();
    let disableRecursion = false;

    let working: WorldBookEntry[] = [...entries];

    const rebuildWorking = (): WorldBookEntry[] =>
      entries.map((e) => {
        const isDisabled = disabledByChain.has(e.id);
        const wantsEnable = !isDisabled && enabledByChain.has(e.id) && e.disabled;
        const wantsForce = !isDisabled && forcedByChain.has(e.id);
        const newContent = contentOverrides.get(e.id);
        if (!isDisabled && !wantsEnable && !wantsForce && newContent === undefined) {
          return e;
        }
        return {
          ...e,
          ...(isDisabled ? { disabled: true } : {}),
          ...(wantsEnable ? { disabled: false } : {}),
          ...(wantsForce ? { constant: true } : {}),
          ...(newContent !== undefined ? { content: newContent } : {}),
        };
      });

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== userId) continue;
      try {
        const result = await handler.handler({
          ...ctx,
          entries: buildDto(working),
          activationSettings: {
            globalScanDepth: ctx.activationSettings.globalScanDepth,
            maxRecursionPasses: disableRecursion
              ? 0
              : ctx.activationSettings.maxRecursionPasses,
          },
        });
        const disabledList = result?.disabled ?? [];
        const enabledList = result?.enabled ?? [];
        const forcedList = result?.forced ?? [];
        const mutatedList = result?.mutated ?? [];
        const capturedList = result?.captured;
        if (capturedList !== undefined) {
          const requested = captureRequests.get(handler.extensionId) ?? new Set<string>();
          for (const id of capturedList) {
            if (candidateIds.has(id)) requested.add(id);
          }
          captureRequests.set(handler.extensionId, requested);
        }
        const activationOverrides = result?.activationOverrides;
        const disablesRecursion = activationOverrides?.disableRecursion === true;
        if (
          disabledList.length === 0 &&
          enabledList.length === 0 &&
          forcedList.length === 0 &&
          mutatedList.length === 0 &&
          !disablesRecursion
        ) {
          continue;
        }

        for (const id of disabledList) disabledByChain.add(id);
        for (const id of enabledList) enabledByChain.add(id);
        for (const id of forcedList) forcedByChain.add(id);
        for (const m of mutatedList) {
          if (!candidateIds.has(m.id)) continue;
          if (m.content !== undefined) contentOverrides.set(m.id, m.content);
          if (m.selectionContent !== undefined) {
            selectionContentByEntryId.set(m.id, m.selectionContent);
          }
          const placement = normalizePlacement(m.placement);
          if (placement) placementByEntryId.set(m.id, placement);
          if (m.outputOrder === "insertion") {
            insertionOrderByEntryId.set(m.id, handler.extensionId);
          } else if (m.outputOrder === "selection") {
            insertionOrderByEntryId.delete(m.id);
          }
        }
        disableRecursion ||= disablesRecursion;

        if (
          disabledList.length > 0 ||
          enabledList.length > 0 ||
          forcedList.length > 0 ||
          mutatedList.length > 0
        ) {
          working = rebuildWorking();
        }
      } catch (err) {
        console.error(
          `[Spindle] World-info interceptor error from ${handler.extensionId}: ${err instanceof Error ? err.message : String(err)}`
        );
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
      }
    }

    return {
      entries: working,
      captureRequests,
      activationOverrides: {
        ...(disableRecursion ? { disableRecursion: true as const } : {}),
      },
      selectionContentByEntryId,
      placementByEntryId,
      insertionOrderByEntryId,
    };
  }

  get count(): number {
    return this.handlers.length;
  }
}

export const worldInfoInterceptorChain = new WorldInfoInterceptorChain();
