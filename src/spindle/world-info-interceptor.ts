import type { WorldBookEntry } from "../types/world-book";

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
  readonly priority: number;
  readonly probability: number;
  readonly use_probability: boolean;
  readonly content: string;
  readonly automation_id: string | null;
  readonly selective: boolean;
  readonly selective_logic: number;
  readonly match_whole_words: boolean;
  readonly case_sensitive: boolean;
  readonly use_regex: boolean;
  readonly prevent_recursion: boolean;
  readonly exclude_recursion: boolean;
  readonly delay_until_recursion: boolean;
  readonly scan_depth: number | null;
  readonly order_value: number;
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

export interface WorldInfoInterceptorCtxDTO {
  readonly chatId: string;
  readonly characterId: string;
  readonly userId?: string;
  readonly entries: readonly WorldInfoInterceptorEntryDTO[];
  readonly messages: readonly WorldInfoInterceptorMessageDTO[];
  readonly chatTurn: number;
  readonly chatMetadata: Readonly<Record<string, unknown>>;
}

export interface WorldInfoInterceptorMutationDTO {
  readonly id: string;
  readonly content?: string;
}

export interface WorldInfoInterceptorResultDTO {
  readonly disabled?: readonly string[];
  readonly enabled?: readonly string[];
  readonly forced?: readonly string[];
  readonly mutated?: readonly WorldInfoInterceptorMutationDTO[];
}

export interface WorldInfoInterceptor {
  extensionId: string;
  userId?: string | null;
  priority: number;
  handler: (
    ctx: WorldInfoInterceptorCtxDTO
  ) => Promise<WorldInfoInterceptorResultDTO | void>;
}

const INTERCEPTOR_TIMEOUT_MS = 10_000;

class WorldInfoInterceptorChain {
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
    userId?: string | null
  ): Promise<WorldBookEntry[]> {
    if (this.handlers.length === 0) return [...entries];

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
        priority: e.priority,
        probability: e.probability,
        use_probability: e.use_probability,
        content: e.content,
        automation_id: e.automation_id,
        selective: e.selective,
        selective_logic: e.selective_logic,
        match_whole_words: e.match_whole_words,
        case_sensitive: e.case_sensitive,
        use_regex: e.use_regex,
        prevent_recursion: e.prevent_recursion,
        exclude_recursion: e.exclude_recursion,
        delay_until_recursion: e.delay_until_recursion,
        scan_depth: e.scan_depth,
        order_value: e.order_value,
      }));

    const disabledByChain = new Set<string>();
    const enabledByChain = new Set<string>();
    const forcedByChain = new Set<string>();
    const contentOverrides = new Map<string, string>();

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
        const result = await Promise.race([
          handler.handler({ ...ctx, entries: buildDto(working) }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `World-info interceptor from ${handler.extensionId} timed out (${INTERCEPTOR_TIMEOUT_MS / 1000}s)`
                  )
                ),
              INTERCEPTOR_TIMEOUT_MS
            )
          ),
        ]);
        const disabledList = result?.disabled ?? [];
        const enabledList = result?.enabled ?? [];
        const forcedList = result?.forced ?? [];
        const mutatedList = result?.mutated ?? [];
        if (
          disabledList.length === 0 &&
          enabledList.length === 0 &&
          forcedList.length === 0 &&
          mutatedList.length === 0
        ) {
          continue;
        }

        for (const id of disabledList) disabledByChain.add(id);
        for (const id of enabledList) enabledByChain.add(id);
        for (const id of forcedList) forcedByChain.add(id);
        for (const m of mutatedList) {
          if (m.content !== undefined) contentOverrides.set(m.id, m.content);
        }

        working = rebuildWorking();
      } catch (err) {
        console.error(
          `[Spindle] World-info interceptor error from ${handler.extensionId}:`,
          err
        );
      }
    }

    return working;
  }

  get count(): number {
    return this.handlers.length;
  }
}

export const worldInfoInterceptorChain = new WorldInfoInterceptorChain();
