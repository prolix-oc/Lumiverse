import type { MacroDefinition } from "./types";

export class MacroRegistry {
  private macros = new Map<string, MacroDefinition>();
  private aliases = new Map<string, string>();

  registerMacro(def: MacroDefinition): boolean {
    const key = def.name.toLowerCase();
    const existing = this.macros.get(key);
    if (existing?.builtIn && !def.builtIn) {
      // Reject: extensions cannot overwrite built-in macros
      return false;
    }
    this.macros.set(key, def);
    if (def.aliases) {
      for (const alias of def.aliases) {
        this.aliases.set(alias.toLowerCase(), key);
      }
    }
    return true;
  }

  registerAlias(primaryName: string, alias: string): void {
    this.aliases.set(alias.toLowerCase(), primaryName.toLowerCase());
  }

  unregisterMacro(name: string): void {
    const key = name.toLowerCase();
    const primary = this.aliases.get(key) ?? key;
    this.macros.delete(primary);

    for (const [alias, target] of this.aliases.entries()) {
      if (alias === key || target === primary) {
        this.aliases.delete(alias);
      }
    }
  }

  getMacro(name: string): MacroDefinition | null {
    const key = name.toLowerCase();
    const def = this.macros.get(key);
    if (def) return def;
    const primary = this.aliases.get(key);
    if (primary) return this.macros.get(primary) ?? null;
    return null;
  }

  hasMacro(name: string): boolean {
    return this.getMacro(name) !== null;
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
    return Array.from(cats.entries()).map(([category, macros]) => ({ category, macros }));
  }
}

/** Singleton registry instance */
export const registry = new MacroRegistry();
