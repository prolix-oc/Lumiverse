/**
 * A preset profile binding captures a snapshot of which prompt blocks are
 * enabled/disabled in a given preset. These snapshots can be bound to a
 * specific character or chat so that block states are automatically restored
 * when the user switches context.
 *
 * Resolution order during prompt assembly:
 *   1. Chat binding   (presetProfile:chat:{chatId})
 *   2. Character binding (presetProfile:character:{characterId})
 *   3. Default snapshot   (presetProfileDefaults)
 *   4. Raw preset block states (no override)
 */
export interface PresetProfileBinding {
  /** Which preset this snapshot was taken from */
  preset_id: string;
  /** Map of block ID → enabled state */
  block_states: Record<string, boolean>;
  /** Unix epoch seconds when the snapshot was captured */
  captured_at: number;
  /**
   * When true, this binding delegates to the current defaults instead of using
   * its own block_states. This allows a chat to stay in sync with the defaults
   * so that updating the defaults propagates to all linked chats.
   */
  linked_to_defaults?: boolean;
}

export interface ResolvedPresetProfile {
  /** The binding that was applied, or null if none matched */
  binding: PresetProfileBinding | null;
  /** Where the binding came from */
  source: "chat" | "character" | "defaults" | "none";
}
