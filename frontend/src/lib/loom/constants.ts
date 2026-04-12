import type {
  SamplerOverrides,
  CustomBody,
  PromptBehavior,
  CompletionSettings,
  AdvancedSettings,
  SamplerParam,
  PromptTemplateItem,
  AddableMarkerItem,
  InjectionTriggerType,
  ContinuePostfixOption,
  NamesBehaviorOption,
} from './types'

// ============================================================================
// ST PRESET CONVERSION MAPS
// ============================================================================

/** Category marker character used in ST preset names */
export const CATEGORY_MARKER = '\u2501' // ━

/** Maps ST preset well-known identifiers → internal marker types */
export const ST_IDENTIFIER_TO_MARKER: Record<string, string> = {
  chatHistory: 'chat_history',
  worldInfoBefore: 'world_info_before',
  worldInfoAfter: 'world_info_after',
  charDescription: 'char_description',
  charPersonality: 'char_personality',
  personaDescription: 'persona_description',
  scenario: 'scenario',
  dialogueExamples: 'dialogue_examples',
  main: 'main_prompt',
  enhanceDefinitions: 'enhance_definitions',
  jailbreak: 'jailbreak',
  nsfw: 'nsfw_prompt',
}

/** Reverse map: internal marker type → ST identifier (for export) */
export const MARKER_TO_ST_IDENTIFIER: Record<string, string> = Object.fromEntries(
  Object.entries(ST_IDENTIFIER_TO_MARKER).map(([k, v]) => [v, k])
)

// ============================================================================
// MARKER NAMES & SETS
// ============================================================================

export const MARKER_NAMES: Record<string, string> = {
  chat_history: 'Chat History',
  world_info_before: 'World Info (Before)',
  world_info_after: 'World Info (After)',
  char_description: 'Char Description',
  char_personality: 'Char Personality',
  persona_description: 'User Persona',
  scenario: 'Scenario',
  dialogue_examples: 'Example Messages',
  main_prompt: 'Main Prompt',
  enhance_definitions: 'Enhance Definitions',
  jailbreak: 'Post-History Instructions',
  nsfw_prompt: 'NSFW Prompt',
  category: 'Category',
}

export const STRUCTURAL_MARKERS = new Set([
  'chat_history',
  'world_info_before',
  'world_info_after',
  'char_description',
  'char_personality',
  'persona_description',
  'scenario',
  'dialogue_examples',
])

export const CONTENT_BEARING_MARKERS = new Set([
  'main_prompt',
  'enhance_definitions',
  'jailbreak',
  'nsfw_prompt',
])

// ============================================================================
// DEFAULT VALUES
// ============================================================================

export const DEFAULT_SAMPLER_OVERRIDES: SamplerOverrides = {
  enabled: true,
  maxTokens: null,
  contextSize: null,
  temperature: null,
  topP: null,
  minP: null,
  topK: null,
  frequencyPenalty: null,
  presencePenalty: null,
  repetitionPenalty: null,
  streaming: true,
}

export const DEFAULT_CUSTOM_BODY: CustomBody = {
  enabled: false,
  rawJson: '{}',
}

export const DEFAULT_PROMPT_BEHAVIOR: PromptBehavior = {
  continueNudge: '[Continue your last message without repeating its original content.]',
  impersonationPrompt: '[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t describe actions of {{char}}.]',
  groupNudge: '[Write the next reply only as {{char}}.]',
  newChatPrompt: '[Start a new Chat]',
  newGroupChatPrompt: '[Start a new group chat. Group members: {{group}}]',
  sendIfEmpty: '',
}

export const DEFAULT_COMPLETION_SETTINGS: CompletionSettings = {
  assistantPrefill: '',
  assistantImpersonation: '',
  continuePrefill: false,
  continuePostfix: ' ',
  namesBehavior: 0,
  squashSystemMessages: false,
  useSystemPrompt: true,
  enableWebSearch: false,
  sendInlineMedia: true,
  enableFunctionCalling: true,
  includeUsage: false,
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  seed: -1,
  customStopStrings: [],
  collapseMessages: false,
}

// ============================================================================
// SAMPLER PARAMETER METADATA
// ============================================================================

export const SAMPLER_PARAMS: SamplerParam[] = [
  { key: 'maxTokens', label: 'Max Response', apiKey: 'max_tokens', type: 'int', min: 1, max: 128000, step: 1, defaultHint: 16384, unit: 'tokens', apiKeyBySource: { makersuite: 'maxOutputTokens', vertexai: 'maxOutputTokens' } },
  { key: 'contextSize', label: 'Context Size', apiKey: 'max_context_length', type: 'int', min: 1024, max: 2097152, step: 1024, defaultHint: 128000, unit: 'tokens' },
  { key: 'temperature', label: 'Temperature', apiKey: 'temperature', type: 'float', min: 0, max: 2, step: 0.01, defaultHint: 1.0 },
  { key: 'topP', label: 'Top P', apiKey: 'top_p', type: 'float', min: 0, max: 1, step: 0.01, defaultHint: 0.95 },
  { key: 'minP', label: 'Min P', apiKey: 'min_p', type: 'float', min: 0, max: 1, step: 0.01, defaultHint: 0 },
  { key: 'topK', label: 'Top K', apiKey: 'top_k', type: 'int', min: 0, max: 500, step: 1, defaultHint: 0 },
  { key: 'frequencyPenalty', label: 'Freq Penalty', apiKey: 'frequency_penalty', type: 'float', min: 0, max: 2, step: 0.01, defaultHint: 0, optIn: true },
  { key: 'presencePenalty', label: 'Pres Penalty', apiKey: 'presence_penalty', type: 'float', min: 0, max: 2, step: 0.01, defaultHint: 0, optIn: true },
  { key: 'repetitionPenalty', label: 'Rep Penalty', apiKey: 'repetition_penalty', type: 'float', min: 0, max: 2, step: 0.01, defaultHint: 0, optIn: true },
]

// ============================================================================
// PROVIDER PARAMETER SUPPORT
// ============================================================================

// Keyed on canonical Lumiverse provider IDs (matches `profile.provider` from
// connection profiles and each backend provider's registration ID). Each set
// must mirror that provider's `capabilities.parameters` allowlist in
// `src/llm/providers/*.ts` — parameters not in the backend allowlist are
// dropped silently before reaching the API, so surfacing them in the UI would
// be misleading.
export const PROVIDER_PARAMS: Record<string, Set<string>> = {
  openai: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  anthropic: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK']),
  google: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK']),
  google_vertex: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK']),
  openrouter: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'minP', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty']),
  deepseek: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  chutes: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  nanogpt: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  zai: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  moonshot: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  mistral: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'minP', 'frequencyPenalty', 'presencePenalty']),
  ai21: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  perplexity: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  groq: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  xai: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  electronhub: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  fireworks: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'minP', 'frequencyPenalty', 'presencePenalty']),
  pollinations: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty']),
  siliconflow: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty']),
  custom: new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'topK', 'minP', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty']),
}

export const DEFAULT_PROVIDER_PARAMS = new Set(['maxTokens', 'contextSize', 'temperature', 'topP', 'frequencyPenalty', 'presencePenalty'])

// ============================================================================
// PROVIDER DISPLAY NAMES
// ============================================================================

// Keyed on canonical Lumiverse provider IDs (same as PROVIDER_PARAMS above).
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  google: 'Google AI Studio',
  google_vertex: 'Vertex AI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  chutes: 'Chutes',
  nanogpt: 'NanoGPT',
  zai: 'Z.AI',
  moonshot: 'Moonshot',
  mistral: 'Mistral',
  ai21: 'AI21',
  perplexity: 'Perplexity',
  groq: 'Groq',
  xai: 'xAI',
  electronhub: 'ElectronHub',
  fireworks: 'Fireworks',
  pollinations: 'Pollinations',
  siliconflow: 'SiliconFlow',
  custom: 'Custom',
}

// ============================================================================
// PROMPT TEMPLATES
// ============================================================================

export const PROMPT_TEMPLATES: PromptTemplateItem[] = [
  { name: 'Blank Prompt', content: '', role: 'system', description: 'Empty prompt block' },
  { section: 'Lumiverse Lumia' },
  { name: 'Lumia Definition(s)', content: '{{lumiaDef}}', role: 'system', description: 'Physical definition of selected Lumia(e)' },
  { name: 'Lumia Personality + Behaviors', content: '{{lumiaPersonality}}\n\n{{lumiaBehavior}}', role: 'system', description: 'Combined personality and behavioral traits' },
  { name: 'Lumia Quirks', content: '{{lumiaQuirks}}', role: 'system', description: 'Behavioral quirks' },
  { name: 'Lumia OOC', content: '{{lumiaOOC}}', role: 'system', description: 'OOC commentary trigger' },
  { section: 'Lumiverse Loom' },
  { name: 'Loom Narrative Style', content: '{{loomStyle}}', role: 'system', description: 'Prose style guidance' },
  { name: 'Loom Utilities', content: '{{loomUtils}}', role: 'system', description: 'All utility prompts' },
  { name: 'Loom Retrofits', content: '{{loomRetrofits}}', role: 'system', description: 'Character/story retrofits' },
  { name: 'Sovereign Hand', content: '{{loomSovHand}}', role: 'system', description: 'Co-pilot mode prompt' },
  { name: 'Story Summary', content: '{{loomSummary}}', role: 'system', description: 'Current story summary' },
  { section: 'Lumiverse Council' },
  { name: 'Council Instructions', content: '{{lumiaCouncilInst}}', role: 'system', description: 'Council mode instructions' },
  { name: 'Council Deliberation', content: '{{lumiaCouncilDeliberation}}', role: 'system', description: 'Tool execution results' },
  { name: 'State Synthesis', content: '{{lumiaStateSynthesis}}', role: 'system', description: 'Member state synthesis' },
  { section: 'Long-Term Memory' },
  { name: 'Chat Memories', content: '{{memories}}', role: 'system', description: 'Retrieved memory chunks with header' },
  { name: 'Chat Memories (Raw)', content: '{{memoriesRaw}}', role: 'system', description: 'Memory chunks without header wrapper' },
  { section: 'Memory Cortex' },
  { name: 'Entity Snapshots', content: '{{entities}}', role: 'system', description: 'Active entities with facts and relationships' },
  { name: 'Relationships', content: '{{relationships}}', role: 'system', description: 'Active relationship edges between entities' },
  { name: 'Story Arc', content: '{{arc}}', role: 'system', description: 'Current narrative arc summary' },
  { name: 'Top Salience Memory', content: '{{memorySalience}}', role: 'system', description: 'Highest-importance memory from retrieval' },
  { section: 'Character Card' },
  { name: 'Scenario', content: '{{scenario}}', role: 'system', description: 'Character scenario' },
  { name: 'Character Description', content: '{{description}}', role: 'system', description: 'Physical description' },
  { name: 'Personality', content: '{{personality}}', role: 'system', description: 'Character personality' },
  { name: 'User Persona', content: '{{persona}}', role: 'system', description: 'User persona description' },
  { name: 'Example Messages', content: '{{mesExamples}}', role: 'system', description: 'Example dialogue' },
]

// ============================================================================
// ADDABLE MARKERS
// ============================================================================

export const ADDABLE_MARKERS: AddableMarkerItem[] = [
  { section: 'Structural' },
  'chat_history',
  'world_info_before',
  'world_info_after',
  { section: 'Character' },
  'char_description',
  'char_personality',
  'persona_description',
  'scenario',
  'dialogue_examples',
  { section: 'Prompts' },
  'main_prompt',
  'enhance_definitions',
  'jailbreak',
  'nsfw_prompt',
]

// ============================================================================
// INJECTION TRIGGER TYPES
// ============================================================================

export const INJECTION_TRIGGER_TYPES: InjectionTriggerType[] = [
  { value: 'normal', label: 'Normal', shortLabel: 'N' },
  { value: 'continue', label: 'Continue', shortLabel: 'C' },
  { value: 'impersonate', label: 'Impersonate', shortLabel: 'I' },
  { value: 'quiet', label: 'Quiet', shortLabel: 'Q' },
  { value: 'swipe', label: 'Swipe', shortLabel: 'S' },
  { value: 'regenerate', label: 'Regenerate', shortLabel: 'R' },
]

// ============================================================================
// SELECT OPTIONS
// ============================================================================

export const CONTINUE_POSTFIX_OPTIONS: ContinuePostfixOption[] = [
  { value: '', label: 'None' },
  { value: ' ', label: 'Space' },
  { value: '\n', label: 'Newline' },
  { value: '\n\n', label: 'Double Newline' },
]

export const NAMES_BEHAVIOR_OPTIONS: NamesBehaviorOption[] = [
  { value: -1, label: 'None' },
  { value: 0, label: 'Default' },
  { value: 1, label: 'In Completion' },
  { value: 2, label: 'In Content' },
]
