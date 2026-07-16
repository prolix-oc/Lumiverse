import type { MacroArgDef, MacroDefinition } from "./types";

/**
 * The generation is assigned by the host when an extension worker starts. It
 * is deliberately not supplied by the worker payload: delayed messages from a
 * previous worker must never be able to mutate the current registration.
 */
export interface MacroOwner {
  readonly extensionId: string;
  readonly generation: string;
}

export interface MacroGenerationActivation {
  readonly owner: MacroOwner;
  readonly previousOwner: MacroOwner | null;
}

export type MacroSource = "core-public" | "extension-owned";

export interface MacroRegistration {
  readonly source: MacroSource;
  readonly owner?: MacroOwner;
}

export interface PublicMacroCatalogArg {
  name: string;
  optional: boolean;
}

export interface PublicMacroCatalogEntry {
  name: string;
  syntax: string;
  description: string;
  args?: PublicMacroCatalogArg[];
  returns?: string;
  category: string;
}

export interface PublicMacroCatalogCategory {
  category: string;
  macros: PublicMacroCatalogEntry[];
}

export interface PublicMacroCatalog {
  categories: PublicMacroCatalogCategory[];
}

/**
 * Names are case-insensitive throughout the registry. Keep the canonical
 * spelling in one place so primary names, aliases, and worker caches cannot
 * diverge.
 */
export function canonicalMacroName(name: string): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function canonicalExtensionId(extensionId: string): string {
  return typeof extensionId === "string" ? extensionId.trim() : "";
}

function normalizeOwner(owner: unknown): MacroOwner | null {
  if (!owner || typeof owner !== "object") return null;
  const candidate = owner as Partial<MacroOwner>;
  const extensionId = canonicalExtensionId(candidate.extensionId ?? "");
  const generation = typeof candidate.generation === "string" ? candidate.generation.trim() : "";
  if (!extensionId || !generation) return null;
  return { extensionId, generation };
}

function sameOwner(a: MacroOwner | undefined, b: MacroOwner | undefined): boolean {
  return !!a && !!b && a.extensionId === b.extensionId && a.generation === b.generation;
}

function copyOwner(owner: MacroOwner): MacroOwner {
  return { extensionId: owner.extensionId, generation: owner.generation };
}

function normalizeAliases(aliases: unknown, primary: string): string[] | undefined {
  if (!Array.isArray(aliases)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of aliases) {
    if (typeof value !== "string") continue;
    const display = value.trim();
    const key = canonicalMacroName(display);
    if (!key || key === primary || seen.has(key)) continue;
    seen.add(key);
    result.push(display);
  }
  return result.length > 0 ? result : undefined;
}

function safeExtensionCategory(category: unknown, extensionId: string): string {
  const prefix = `extension:${extensionId}`;
  const candidate = typeof category === "string" ? category.trim() : "";
  const lowerCandidate = candidate.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerCandidate === lowerPrefix || lowerCandidate.startsWith(`${lowerPrefix}:`)) {
    return candidate;
  }
  return prefix;
}

function compareText(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export class MacroRegistry {
  private macros = new Map<string, MacroDefinition>();
  private aliases = new Map<string, string>();
  private registrations = new Map<string, MacroRegistration>();
  private activeGenerations = new Map<string, string>();
  private activationTokens = new WeakSet<object>();
  /**
   * Register a trusted core definition. Core definitions are immutable from
   * the extension-facing APIs and are stamped as built-ins here rather than
   * trusting metadata arriving from an extension worker.
   */
  registerMacro(def: MacroDefinition): boolean {
    return this.registerDefinition(def, { source: "core-public" });
  }

  /**
   * Begin activating a worker generation and retain the incumbent for a
   * compare-and-swap rollback if transport construction fails.
   */
  beginExtensionGeneration(owner: MacroOwner): MacroGenerationActivation | null {
    const normalized = normalizeOwner(owner);
    if (!normalized) return null;
    const previousGeneration = this.activeGenerations.get(normalized.extensionId);
    const previousOwner = previousGeneration
      ? Object.freeze({ extensionId: normalized.extensionId, generation: previousGeneration })
      : null;
    this.activeGenerations.set(normalized.extensionId, normalized.generation);
    const activation = Object.freeze({
      owner: Object.freeze(copyOwner(normalized)),
      previousOwner,
    });
    this.activationTokens.add(activation);
    return activation;
  }

  /**
   * Preserve a newer concurrent activation: rollback only when this
   * transaction still owns the active generation slot.
   */
  rollbackExtensionGeneration(activation: unknown): boolean {
    if (activation === null || typeof activation !== "object" || !this.activationTokens.has(activation)) {
      return false;
    }
    this.activationTokens.delete(activation);
    const candidate = activation as MacroGenerationActivation;
    const normalized = normalizeOwner(candidate.owner);
    if (!normalized || this.activeGenerations.get(normalized.extensionId) !== normalized.generation) {
      return false;
    }
    const previousOwner = candidate.previousOwner === null
      ? null
      : normalizeOwner(candidate.previousOwner);
    if (candidate.previousOwner !== null && !previousOwner) return false;
    if (previousOwner && previousOwner.extensionId !== normalized.extensionId) return false;
    if (previousOwner) {
      this.activeGenerations.set(normalized.extensionId, previousOwner.generation);
    } else {
      this.activeGenerations.delete(normalized.extensionId);
    }
    return true;
  }

  commitExtensionGeneration(activation: unknown): boolean {
    if (activation === null || typeof activation !== "object" || !this.activationTokens.has(activation)) {
      return false;
    }
    this.activationTokens.delete(activation);
    const candidate = activation as MacroGenerationActivation;
    const normalized = normalizeOwner(candidate.owner);
    return !!normalized && this.activeGenerations.get(normalized.extensionId) === normalized.generation;
  }
  activateExtensionGeneration(owner: MacroOwner): boolean {
    const activation = this.beginExtensionGeneration(owner);
    if (!activation) return false;
    return this.commitExtensionGeneration(activation);
  }


  deactivateExtensionGeneration(owner: MacroOwner): boolean {
    const normalized = normalizeOwner(owner);
    if (!normalized) return false;
    if (this.activeGenerations.get(normalized.extensionId) !== normalized.generation) {
      return false;
    }
    this.activeGenerations.delete(normalized.extensionId);
    return true;
  }

  isActiveOwner(owner: MacroOwner): boolean {
    const normalized = normalizeOwner(owner);
    return !!normalized &&
      this.activeGenerations.get(normalized.extensionId) === normalized.generation;
  }

  /**
   * Register an extension definition under a host-authored owner token.
   * Registration is atomic: a collision in the primary name or any alias
   * rejects the entire definition without disturbing the existing owner.
   */
  registerExtensionMacro(def: MacroDefinition, owner: MacroOwner): boolean {
    if (!def || typeof def !== "object") return false;
    const normalizedOwner = normalizeOwner(owner);
    if (!normalizedOwner) return false;
    if (!this.ensureActiveOwner(normalizedOwner)) return false;
    return this.registerDefinition(
      {
        ...def,
        builtIn: false,
        category: safeExtensionCategory(def.category, normalizedOwner.extensionId),
      },
      { source: "extension-owned", owner: normalizedOwner },
    );
  }

  /**
   * Register an alias for an existing definition. Worker code should use
   * registerExtensionMacro instead so aliases are checked atomically with the
   * primary registration.
   */
  registerAlias(primaryName: string, alias: string, owner?: MacroOwner): boolean {
    const primary = this.resolvePrimary(primaryName);
    const aliasKey = canonicalMacroName(alias);
    if (!primary || !aliasKey || aliasKey === primary) return false;
    const registration = this.registrations.get(primary);
    if (!registration) return false;

    if (owner) {
      const normalizedOwner = normalizeOwner(owner);
      if (!normalizedOwner || !this.isActiveOwner(normalizedOwner) ||
          !sameOwner(registration.owner, normalizedOwner)) {
        return false;
      }
    } else if (registration.source !== "core-public") {
      return false;
    }

    const existingPrimary = this.resolvePrimary(aliasKey);
    if (existingPrimary && existingPrimary !== primary) return false;
    this.aliases.set(aliasKey, primary);
    return true;
  }

  /**
   * Remove one definition only when the supplied owner still owns the active
   * registration. No-owner removal remains for trusted core callers but can
   * never remove a built-in.
   */
  unregisterMacro(name: string, owner?: MacroOwner): boolean {
    const primary = this.resolvePrimary(name);
    if (!primary) return false;
    const registration = this.registrations.get(primary);
    if (!registration) return false;

    if (owner) {
      const normalizedOwner = normalizeOwner(owner);
      if (!normalizedOwner || !this.isActiveOwner(normalizedOwner) ||
          !sameOwner(registration.owner, normalizedOwner)) {
        return false;
      }
    } else if (registration.source === "core-public") {
      return false;
    }

    this.removePrimary(primary);
    return true;
  }

  /**
   * Remove all definitions owned by one worker generation. This intentionally
   * does not require the generation to remain active, because cleanup races
   * with a replacement worker and must still retire the old generation.
   */
  unregisterOwner(owner: MacroOwner): number {
    const normalizedOwner = normalizeOwner(owner);
    if (!normalizedOwner) return 0;
    let removed = 0;
    for (const [primary, registration] of this.registrations) {
      if (sameOwner(registration.owner, normalizedOwner)) {
        this.removePrimary(primary);
        removed++;
      }
    }
    return removed;
  }

  getMacro(name: string): MacroDefinition | null {
    const primary = this.resolvePrimary(name);
    return primary ? this.macros.get(primary) ?? null : null;
  }
  /** Return the canonical primary name for a primary or alias lookup. */
  getPrimaryName(name: string): string | null {
    return this.resolvePrimary(name)
  }

  hasMacro(name: string): boolean {
    return this.getMacro(name) !== null;
  }

  /**
   * True only while the named definition belongs to the current worker
   * generation. Handlers use this guard before reading worker-owned caches.
   */
  isOwnedMacro(name: string, owner: MacroOwner): boolean {
    const normalizedOwner = normalizeOwner(owner);
    const primary = this.resolvePrimary(name);
    const registration = primary ? this.registrations.get(primary) : undefined;
    return !!normalizedOwner &&
      this.isActiveOwner(normalizedOwner) &&
      !!registration &&
      sameOwner(registration.owner, normalizedOwner);
  }

  getRegistration(name: string): MacroRegistration | null {
    const primary = this.resolvePrimary(name);
    const registration = primary ? this.registrations.get(primary) : undefined;
    if (!registration) return null;
    return {
      source: registration.source,
      owner: registration.owner ? copyOwner(registration.owner) : undefined,
    };
  }

  getAllMacros(): MacroDefinition[] {
    return Array.from(this.macros.values());
  }

  getCategories(): { category: string; macros: MacroDefinition[] }[] {
    const cats = new Map<string, MacroDefinition[]>();
    for (const def of this.macros.values()) {
      const list = cats.get(def.category) ?? [];
      list.push(def);
      cats.set(def.category, list);
    }
    return Array.from(cats.entries())
      .sort(([a], [b]) => compareText(a, b))
      .map(([category, macros]) => ({
        category,
        macros: macros.slice().sort((a, b) => compareText(a.name, b.name)),
      }));
  }

  /**
   * Return only the closed catalog DTO used by public routes and components.
   *
   * Without an owner this is the core-public catalog. An owner-scoped catalog
   * additionally includes definitions owned by that exact active worker
   * generation; registrations belonging to any other extension never cross
   * this boundary.
   */
  getPublicCatalog(owner?: MacroOwner): PublicMacroCatalog {
    return this.buildCatalog(owner ? normalizeOwner(owner) : null);
  }

  /**
   * Trusted Main catalog. Main may browse every currently active extension
   * registration, while public extension mounts must use getPublicCatalog(owner)
   * so one extension cannot see another extension's macros.
   */
  getMainCatalog(): PublicMacroCatalog {
    return this.buildCatalog("main");
  }

  private buildCatalog(scope: MacroOwner | "main" | null): PublicMacroCatalog {
    const categories = new Map<string, PublicMacroCatalogEntry[]>();
    for (const [primary, registration] of this.registrations) {
      if (registration.source === "core-public") {
        // Core definitions are always available to public consumers.
      } else if (
        registration.source === "extension-owned" &&
        registration.owner &&
        scope &&
        (scope === "main"
          ? this.isActiveOwner(registration.owner)
          : this.isActiveOwner(scope) && sameOwner(registration.owner, scope))
      ) {
        // Owner-scoped catalogs expose only the current worker generation.
      } else {
        continue;
      }
      const def = this.macros.get(primary);
      if (!def) continue;
      const args = Array.isArray(def.args)
        ? def.args
            .filter((arg): arg is MacroArgDef => !!arg && typeof arg.name === "string")
            .map((arg) => ({ name: arg.name.trim(), optional: arg.optional === true }))
            .filter((arg) => arg.name.length > 0)
        : [];
      const entry: PublicMacroCatalogEntry = {
        name: def.name,
        syntax: formatSyntax(def.name, args),
        description: typeof def.description === "string" ? def.description : "",
        category: typeof def.category === "string" && def.category.trim() ? def.category : "Core",
      };
      if (args.length > 0) entry.args = args;
      const returns = typeof def.returns === "string" && def.returns.trim()
        ? def.returns
        : def.returnType;
      if (returns) entry.returns = returns;
      const list = categories.get(entry.category) ?? [];
      list.push(entry);
      categories.set(entry.category, list);
    }

    return {
      categories: Array.from(categories.entries())
        .sort(([a], [b]) => compareText(a, b))
        .map(([category, macros]) => ({
          category,
          macros: macros.slice().sort((a, b) => compareText(a.name, b.name)),
        })),
    };
  }

  private ensureActiveOwner(owner: MacroOwner): boolean {
    return this.activeGenerations.get(owner.extensionId) === owner.generation;
  }

  private registerDefinition(
    def: MacroDefinition,
    registration: MacroRegistration,
  ): boolean {
    if (!def || typeof def !== "object") return false;
    const displayName = typeof def.name === "string" ? def.name.trim() : "";
    const primary = canonicalMacroName(displayName);
    if (!primary || !def.handler || typeof def.handler !== "function") return false;

    const aliases = normalizeAliases(def.aliases, primary);
    const keys = [primary, ...(aliases ?? []).map(canonicalMacroName)];
    const seenKeys = new Set<string>();
    const stalePrimaries = new Set<string>();
    for (const key of keys) {
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const existingPrimary = this.resolvePrimary(key);
      if (!existingPrimary) continue;
      const existingRegistration = this.registrations.get(existingPrimary);
      if (!existingRegistration) return false;
      if (registration.source === "extension-owned") {
        const staleSameExtension =
          existingRegistration.source === "extension-owned" &&
          !!existingRegistration.owner &&
          !!registration.owner &&
          existingRegistration.owner.extensionId === registration.owner.extensionId &&
          existingRegistration.owner.generation !== registration.owner.generation &&
          !this.isActiveOwner(existingRegistration.owner);
        if (staleSameExtension) {
          stalePrimaries.add(existingPrimary);
          continue;
        }
        if (
          existingPrimary !== primary ||
          !sameOwner(existingRegistration.owner, registration.owner)
        ) {
          return false;
        }
      } else if (existingRegistration.source === "core-public") {
        // Core definitions are immutable, including duplicate initializers.
        return false;
      } else {
        // Never silently evict extension-owned metadata when a core producer
        // races initialization with a worker registration.
        return false;
      }
    }
    const normalized: MacroDefinition = {
      ...def,
      name: displayName,
      aliases,
      builtIn: registration.source === "core-public",
      category:
        registration.source === "extension-owned" && registration.owner
          ? safeExtensionCategory(def.category, registration.owner.extensionId)
          : typeof def.category === "string" && def.category.trim()
            ? def.category.trim()
            : "Core",
    };

    for (const stalePrimary of stalePrimaries) {
      this.removePrimary(stalePrimary);
    }
    // A same-owner extension registration is an update of its own definition;
    // remove its old aliases before installing the new complete definition.
    this.removePrimary(primary);
    this.macros.set(primary, normalized);
    this.registrations.set(primary, {
      source: registration.source,
      owner: registration.owner ? copyOwner(registration.owner) : undefined,
    });
    for (const alias of aliases ?? []) {
      this.aliases.set(canonicalMacroName(alias), primary);
    }
    return true;
  }

  private resolvePrimary(name: string): string | null {
    const key = canonicalMacroName(name);
    if (!key) return null;
    if (this.macros.has(key)) return key;
    return this.aliases.get(key) ?? null;
  }

  private removePrimary(primary: string): void {
    this.macros.delete(primary);
    this.registrations.delete(primary);
    for (const [alias, target] of this.aliases) {
      if (target === primary) this.aliases.delete(alias);
    }
  }
}

function formatSyntax(name: string, args: PublicMacroCatalogArg[]): string {
  let syntax = `{{${name}`;
  for (const arg of args) {
    syntax += `::${arg.optional ? `[${arg.name}]` : arg.name}`;
  }
  return `${syntax}}}`;
}

/** Singleton registry instance */
export const registry = new MacroRegistry();
