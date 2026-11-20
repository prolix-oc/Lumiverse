import type { MacroDefinition } from "./types";

export type MacroOrigin =
  | { kind: "system" }
  | { kind: "extension"; extensionId: string };

interface MacroRegistration {
  definition: MacroDefinition;
  origin: MacroOrigin;
}

const SYSTEM_ORIGIN: MacroOrigin = Object.freeze({ kind: "system" });

function sameOrigin(left: MacroOrigin, right: MacroOrigin): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "system") return true;
  return right.kind === "extension" && left.extensionId === right.extensionId;
}

export class MacroRegistry {
  private macros = new Map<string, MacroRegistration>();
  private aliases = new Map<string, string>();

  registerMacro(def: MacroDefinition, origin: MacroOrigin = SYSTEM_ORIGIN): boolean {
    const key = def.name.toLowerCase();
    const existingPrimary = this.aliases.get(key) ?? key;
    const existing = this.macros.get(existingPrimary);
    if (origin.kind === "extension" && existing && !sameOrigin(existing.origin, origin)) {
      return false;
    }

    const aliases = (def.aliases ?? []).map((alias) => alias.toLowerCase());
    for (const alias of aliases) {
      const aliasPrimary = this.aliases.get(alias) ?? alias;
      const aliasExisting = this.macros.get(aliasPrimary);
      if (origin.kind === "extension" && aliasExisting && !sameOrigin(aliasExisting.origin, origin)) {
        return false;
      }
    }

    // A same-owner re-registration replaces its old aliases atomically.
    if (existing && sameOrigin(existing.origin, origin)) {
      if (existingPrimary !== key) this.macros.delete(existingPrimary);
      this.removeAliasesFor(existingPrimary);
    }
    this.macros.set(key, { definition: def, origin });
    for (const alias of aliases) {
      this.aliases.set(alias, key);
    }
    return true;
  }

  registerAlias(primaryName: string, alias: string, origin: MacroOrigin = SYSTEM_ORIGIN): boolean {
    const primary = primaryName.toLowerCase();
    const registration = this.macros.get(primary);
    if (!registration || !sameOrigin(registration.origin, origin)) return false;

    const aliasKey = alias.toLowerCase();
    const existingPrimary = this.aliases.get(aliasKey) ?? aliasKey;
    const existing = this.macros.get(existingPrimary);
    if (origin.kind === "extension" && existing && !sameOrigin(existing.origin, origin)) return false;

    this.aliases.set(aliasKey, primary);
    return true;
  }

  unregisterMacro(name: string, origin: MacroOrigin = SYSTEM_ORIGIN): boolean {
    const key = name.toLowerCase();
    const primary = this.aliases.get(key) ?? key;
    const registration = this.macros.get(primary);
    if (!registration || !sameOrigin(registration.origin, origin)) return false;

    this.macros.delete(primary);
    this.removeAliasesFor(primary);
    return true;
  }

  unregisterByExtension(extensionId: string): void {
    for (const [name, registration] of this.macros.entries()) {
      if (registration.origin.kind === "extension" && registration.origin.extensionId === extensionId) {
        this.macros.delete(name);
        this.removeAliasesFor(name);
      }
    }
  }

  private removeAliasesFor(primary: string): void {
    for (const [alias, target] of this.aliases.entries()) {
      if (alias === primary || target === primary) {
        this.aliases.delete(alias);
      }
    }
  }

  getMacro(name: string): MacroDefinition | null {
    return this.getRegistration(name)?.definition ?? null;
  }

  getMacroOrigin(name: string): MacroOrigin | null {
    return this.getRegistration(name)?.origin ?? null;
  }

  private getRegistration(name: string): MacroRegistration | null {
    const key = name.toLowerCase();
    const registration = this.macros.get(key);
    if (registration) return registration;
    const primary = this.aliases.get(key);
    if (primary) return this.macros.get(primary) ?? null;
    return null;
  }

  hasMacro(name: string): boolean {
    return this.getMacro(name) !== null;
  }

  getAllMacros(): MacroDefinition[] {
    return Array.from(this.macros.values(), ({ definition }) => definition);
  }

  getCategories(): { category: string; macros: MacroDefinition[] }[] {
    const cats = new Map<string, MacroDefinition[]>();
    for (const { definition: def } of this.macros.values()) {
      const list = cats.get(def.category) ?? [];
      list.push(def);
      cats.set(def.category, list);
    }
    return Array.from(cats.entries()).map(([category, macros]) => ({ category, macros }));
  }
}

/** Singleton registry instance */
export const registry = new MacroRegistry();
