/**
 * Spindle UI Automation Registry
 *
 * Backend-side mirror of the frontend's built-in drawer-tab and settings-tab
 * registries. Used by the `spindle.ui` extension API to enumerate the items
 * an extension can navigate the user to (same set the Command Palette draws
 * from for built-in entries).
 *
 * Extension-registered drawer tabs are tracked separately per user in
 * {@link ./ui-frontend-state.service.ts}; they reach the backend via the
 * `SPINDLE_UI_REGISTRY_SYNC` WS message from the frontend.
 *
 * Keep this file in sync with:
 *  - frontend/src/lib/drawer-tab-registry.tsx  (DRAWER_TABS)
 *  - frontend/src/lib/settings-tab-registry.tsx (SETTINGS_TABS)
 */

export type SpindleUIDrawerTabEntry = {
  id: string;
  shortName: string;
  tabName: string;
  tabDescription: string;
  keywords: string[];
};

export type SpindleUISettingsTabEntry = {
  id: string;
  shortName: string;
  tabName: string;
  tabDescription: string;
  keywords: string[];
  /** When set, only users with this role (or higher) see the entry. */
  role?: "admin" | "owner";
};

export const BUILT_IN_DRAWER_TABS: readonly SpindleUIDrawerTabEntry[] = [
  { id: "profile", shortName: "Profile", tabName: "Profile", tabDescription: "View and edit the active character", keywords: ["character", "avatar", "info", "edit", "card", "description", "bio", "greeting", "first message"] },
  { id: "presets", shortName: "Reason", tabName: "Reasoning", tabDescription: "Configure reasoning, chain-of-thought, and prompt behavior", keywords: ["reasoning", "cot", "chain of thought", "thinking", "reasoning effort", "api reasoning", "prompt bias", "start reply with", "prefix", "suffix"] },
  { id: "loom", shortName: "Loom", tabName: "Loom", tabDescription: "Configure narrative structure and story beats", keywords: ["narrative", "story", "lore", "structure", "beats", "loom", "pacing", "plot", "sovereign hand", "director"] },
  { id: "weaver", shortName: "Weaver", tabName: "Weaver", tabDescription: "Craft a character from your idea", keywords: ["weaver", "dream", "character", "create", "ai"] },
  { id: "connections", shortName: "Connect", tabName: "Connections", tabDescription: "Manage API connections and providers", keywords: ["api", "provider", "key", "openai", "anthropic", "model", "endpoint", "google", "vertex", "claude", "gemini", "openrouter", "deepseek", "url", "secret"] },
  { id: "browser", shortName: "Browser", tabName: "Pack Browser", tabDescription: "Browse and manage content packs", keywords: ["packs", "content", "download", "browse", "browser", "install", "marketplace", "library", "search"] },
  { id: "characters", shortName: "Chars", tabName: "Characters", tabDescription: "Browse and manage your character cards", keywords: ["character", "list", "import", "card", "browse", "export", "png", "charx", "gallery", "switch", "select"] },
  { id: "personas", shortName: "Personas", tabName: "Personas", tabDescription: "Manage your user personas", keywords: ["persona", "identity", "user", "avatar", "name", "sender", "you", "addons"] },
  { id: "lorebook", shortName: "Lore", tabName: "Lorebook", tabDescription: "Edit world book and lorebook entries", keywords: ["lorebook", "world", "lore", "book", "entries", "worldbook", "world info", "wi", "keywords", "triggers", "knowledge"] },
  { id: "cortex", shortName: "Memory", tabName: "Memory Cortex", tabDescription: "View and manage memory cortex entries", keywords: ["memory", "cortex", "embeddings", "recall", "brain", "entities", "relationships", "salience", "vector", "long term", "ltcm", "facts"] },
  { id: "databank", shortName: "Data", tabName: "Databank", tabDescription: "Upload and manage reference documents for AI context", keywords: ["databank", "knowledge", "documents", "upload", "files", "bank", "reference", "data", "rag"] },
  { id: "create", shortName: "Create", tabName: "Creator Workshop", tabDescription: "Create and edit Lumia items and Loom presets", keywords: ["create", "workshop", "editor", "build", "new", "lumia", "loom", "author", "write", "draft", "custom"] },
  { id: "ooc", shortName: "OOC", tabName: "OOC", tabDescription: "Out-of-character comment display settings", keywords: ["ooc", "out of character", "comments", "irc", "social", "chat", "meta", "parentheses", "brackets"] },
  { id: "prompt", shortName: "Compose", tabName: "Composition", tabDescription: "Pick Lumia and Loom content, Sovereign Hand, and context filters", keywords: ["composition", "compose", "lumia", "loom", "sovereign hand", "context filters", "narrative", "selection", "modes"] },
  { id: "council", shortName: "Council", tabName: "Council", tabDescription: "Configure the Lumia Council and tool functions", keywords: ["council", "tools", "agents", "lumia", "functions", "tool use", "sidecar", "function calling"] },
  { id: "summary", shortName: "Summary", tabName: "Summary", tabDescription: "Configure context summarization and truncation", keywords: ["summary", "context", "truncation", "compress", "summarize", "shorten", "overflow", "window", "limit"] },
  { id: "feedback", shortName: "Feedback", tabName: "Council Feedback", tabDescription: "View the latest council execution results", keywords: ["feedback", "council", "results", "tools", "output", "debug", "log", "response", "execution", "trace"] },
  { id: "worldinfo", shortName: "WI", tabName: "World Info", tabDescription: "View currently activated world info entries", keywords: ["world info", "activation", "lorebook", "active", "entries", "triggered", "wi", "matched", "fired"] },
  { id: "imagegen", shortName: "ImgGen", tabName: "Image Generation", tabDescription: "Configure and control AI scene generation", keywords: ["image", "generation", "scene", "art", "picture", "ai", "background", "novelai", "nai", "dalle", "illustration"] },
  { id: "wallpaper", shortName: "Wallppr", tabName: "Wallpaper", tabDescription: "Set global or per-chat background wallpapers", keywords: ["wallpaper", "background", "backdrop", "image", "video", "animated", "mp4", "webm", "gif", "scenery", "chat background"] },
  { id: "regex", shortName: "Regex", tabName: "Regex Scripts", tabDescription: "Create and manage regex find/replace scripts", keywords: ["regex", "find", "replace", "script", "transform", "filter", "pattern", "substitution", "text", "output", "display", "rewrite", "format"] },
  { id: "branches", shortName: "Branch", tabName: "Branch Tree", tabDescription: "View and navigate the chat branch history", keywords: ["branch", "fork", "history", "tree", "navigate", "alternate", "swipe", "undo", "timeline", "rewind", "path"] },
  { id: "theme", shortName: "Theme", tabName: "Theme", tabDescription: "Customize colors, accent, and visual style", keywords: ["theme", "colors", "accent", "appearance", "dark", "light", "glass", "radius", "font", "css", "style", "customize", "ui", "mode"] },
  { id: "spindle", shortName: "Extend", tabName: "Extensions", tabDescription: "Manage Spindle extensions", keywords: ["extensions", "spindle", "plugins", "addons", "install", "manage", "enable", "disable", "uninstall", "github"] },
];

export const BUILT_IN_SETTINGS_TABS: readonly SpindleUISettingsTabEntry[] = [
  { id: "account", shortName: "Account", tabName: "Account Settings", tabDescription: "Manage your account details and password", keywords: ["account", "profile", "password", "credentials", "security", "me"] },
  { id: "display", shortName: "Display", tabName: "Display & Layout", tabDescription: "Panel width, sidebar position, and layout options", keywords: ["display", "layout", "sidebar", "drawer", "width", "panel", "position", "modal", "chat heads"] },
  { id: "chat", shortName: "Chat", tabName: "Chat Behavior", tabDescription: "Message display mode, send key, and chat options", keywords: ["chat", "behavior", "enter to send", "bubble", "minimal", "immersive", "streaming", "message"] },
  { id: "extensions", shortName: "Extensions", tabName: "Extension Settings", tabDescription: "Manage Spindle extension configuration", keywords: ["extensions", "spindle", "plugins", "addons", "settings"] },
  { id: "guided", shortName: "Guided Gen", tabName: "Guided Generation", tabDescription: "Configure guided generation sequences and prompt biases", keywords: ["guided", "generation", "sequences", "bias", "prompt", "persistent"] },
  { id: "quickReplies", shortName: "Quick Replies", tabName: "Quick Replies", tabDescription: "Manage quick reply sets and message shortcuts", keywords: ["quick replies", "shortcuts", "messages", "macros", "quick"] },
  { id: "extensionPools", shortName: "Extension Pools", tabName: "Extension Pools", tabDescription: "Configure extension resource pool limits", keywords: ["extension", "pools", "resources", "limits", "storage"] },
  { id: "webSearch", shortName: "Web Search", tabName: "Web Search", tabDescription: "Configure SearXNG-backed web search for council tools", keywords: ["web search", "searxng", "search", "browse", "internet", "web", "council tool"] },
  { id: "embeddings", shortName: "Embeddings", tabName: "Embeddings", tabDescription: "Configure embedding models and vector storage", keywords: ["embeddings", "vectors", "semantic", "search", "similarity", "database", "memory"] },
  { id: "memoryCortex", shortName: "Memory Cortex", tabName: "Memory Cortex Settings", tabDescription: "Configure memory cortex extraction and salience", keywords: ["memory", "cortex", "entities", "relations", "salience", "extraction", "brain", "recall"] },
  { id: "notifications", shortName: "Notifications", tabName: "Notifications", tabDescription: "Configure notification preferences and alerts", keywords: ["notifications", "alerts", "sounds", "push", "desktop", "bell"] },
  { id: "voice", shortName: "Voice", tabName: "Voice & Speech", tabDescription: "Text-to-speech, speech-to-text, and voice settings", keywords: ["voice", "speech", "tts", "stt", "text to speech", "speech to text", "microphone", "audio", "speak", "whisper"] },
  { id: "mcpServers", shortName: "MCP Servers", tabName: "MCP Servers", tabDescription: "Connect to external MCP tool servers for function calling", keywords: ["mcp", "tools", "servers", "model context protocol", "function calling", "external"] },
  { id: "advanced", shortName: "Advanced", tabName: "Advanced Settings", tabDescription: "Advanced configuration and debug options", keywords: ["advanced", "debug", "config", "technical", "expert", "context filters", "reasoning"] },
  { id: "lumihub", shortName: "LumiHub", tabName: "LumiHub", tabDescription: "LumiHub cloud sync and sharing settings", keywords: ["lumihub", "cloud", "sync", "sharing", "online", "hub"] },
  { id: "dataPortability", shortName: "Data", tabName: "Data Portability", tabDescription: "Export your data or import a previously exported archive", keywords: ["data", "portability", "export", "import", "backup", "restore", "archive", "lvbak", "migrate"] },
  { id: "diagnostics", shortName: "Diagnostics", tabName: "Diagnostics", tabDescription: "System health, performance metrics, and debug info", keywords: ["diagnostics", "health", "performance", "debug", "info", "system", "status", "metrics"] },
  { id: "operator", shortName: "Operator", tabName: "Operator Panel", tabDescription: "Server management, updates, and restart controls", keywords: ["operator", "server", "restart", "update", "git", "branch", "logs", "admin"], role: "owner" },
  { id: "tokenizers", shortName: "Tokenizers", tabName: "Tokenizer Manager", tabDescription: "Manage and test tokenizer configurations", keywords: ["tokenizer", "tokens", "count", "encoding", "tiktoken", "bpe"], role: "admin" },
  { id: "users", shortName: "Users", tabName: "User Management", tabDescription: "Manage user accounts, roles, and permissions", keywords: ["users", "accounts", "roles", "permissions", "admin", "management"], role: "admin" },
  { id: "migration", shortName: "Migration", tabName: "Migration", tabDescription: "Import data from SillyTavern and other sources", keywords: ["migration", "import", "sillytavern", "transfer", "data", "convert"], role: "admin" },
];

/** Filter settings tabs by the user's role. */
export function getVisibleSettingsTabs(userRole?: string | null): SpindleUISettingsTabEntry[] {
  const isOwner = userRole === "owner";
  const isAdmin = isOwner || userRole === "admin";
  return BUILT_IN_SETTINGS_TABS.filter((tab) => {
    if (!tab.role) return true;
    if (tab.role === "owner") return isOwner;
    if (tab.role === "admin") return isAdmin;
    return false;
  });
}
