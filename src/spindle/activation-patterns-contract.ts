/** Host additions pending publication in lumiverse-spindle-types. */
export interface ActivationPatternsOptions {
  presetId: string;
  patterns: string[];
  chatId?: string;
  characterId?: string;
  personaId?: string;
  connectionId?: string;
  userId?: string;
}

export interface ActivationPatternsResult {
  patterns: Array<{ source: string; resolved?: string; error?: string }>;
}

export type ActivationPatternsMessage = {
  type: "regex_scripts_prepare_activation_patterns";
  requestId: string;
  options: ActivationPatternsOptions;
};
