import { describe, expect, test } from "bun:test";
import { MacroRegistry, type MacroOwner } from "./MacroRegistry";
import type { MacroDefinition } from "./types";

function definition(
  name: string,
  category: string,
  value: string,
  aliases?: string[],
): MacroDefinition {
  return {
    name,
    category,
    description: `${name} description`,
    aliases,
    returnType: "string",
    handler: () => value,
  };
}

describe("MacroRegistry ownership", () => {
  test("keeps built-ins immutable and isolates extension collisions", () => {
    const registry = new MacroRegistry();
    const owner: MacroOwner = { extensionId: "first", generation: "g1" };

    expect(registry.registerMacro(definition("CoreMacro", "Core", "core"))).toBe(true);
    registry.activateExtensionGeneration(owner);
    expect(
      registry.registerExtensionMacro(
        definition("coremacro", "Core", "extension"),
        owner,
      ),
    ).toBe(false);
    expect(registry.getMacro("COREMACRO")?.handler({} as never)).toBe("core");
    expect(registry.getPublicCatalog().categories).toEqual([
      {
        category: "Core",
        macros: [
          {
            name: "CoreMacro",
            syntax: "{{CoreMacro}}",
            description: "CoreMacro description",
            returns: "string",
            category: "Core",
          },
        ],
      },
    ]);
  });

  test("normalizes primary names and aliases, and rejects alias collisions atomically", () => {
    const registry = new MacroRegistry();
    const first: MacroOwner = { extensionId: "first", generation: "g1" };
    const second: MacroOwner = { extensionId: "second", generation: "g1" };
    registry.activateExtensionGeneration(first);
    registry.activateExtensionGeneration(second);

    expect(
      registry.registerExtensionMacro(
        definition("  Weather  ", "Core", "sunny", ["Forecast", "forecast", "  W  "]),
        first,
      ),
    ).toBe(true);
    expect(registry.getMacro("WEATHER")?.name).toBe("Weather");
    expect(registry.getMacro(" forecast ")?.name).toBe("Weather");
    expect(registry.getMacro("W")?.name).toBe("Weather");
    expect(registry.getPrimaryName("forecast")).toBe("weather");

    expect(
      registry.registerExtensionMacro(
        definition("other", "extension:second", "other", ["FORECAST"]),
        second,
      ),
    ).toBe(false);
    expect(registry.getMacro("other")).toBeNull();
    expect(registry.getMacro("forecast")?.name).toBe("Weather");
  });

  test("stale generations cannot mutate or clean current registrations", () => {
    const registry = new MacroRegistry();
    const oldOwner: MacroOwner = { extensionId: "extension", generation: "old" };
    const currentOwner: MacroOwner = { extensionId: "extension", generation: "current" };
    registry.activateExtensionGeneration(oldOwner);

    expect(
      registry.registerExtensionMacro(
        definition("oldMacro", "extension:extension", "old"),
        oldOwner,
      ),
    ).toBe(true);
    expect(
      registry.registerExtensionMacro(
        definition("oldOnly", "extension:extension", "old only"),
        oldOwner,
      ),
    ).toBe(true);
    registry.activateExtensionGeneration(currentOwner);
    expect(
      registry.registerExtensionMacro(
        definition("oldMacro", "extension:extension", "current"),
        currentOwner,
      ),
    ).toBe(true);
    const publicMacros = registry
      .getPublicCatalog(currentOwner)
      .categories.flatMap((category) => category.macros);
    expect(publicMacros.some((macro) => macro.name === "oldMacro")).toBe(true);
    expect(publicMacros.some((macro) => macro.name === "oldOnly")).toBe(false);
    expect(registry.isOwnedMacro("oldMacro", oldOwner)).toBe(false);
    expect(registry.unregisterMacro("oldMacro", oldOwner)).toBe(false);
    expect(registry.registerExtensionMacro(definition("newMacro", "", "new"), oldOwner)).toBe(false);

    expect(registry.unregisterOwner(oldOwner)).toBe(1);
    expect(registry.registerExtensionMacro(definition("newMacro", "", "new"), currentOwner)).toBe(true);
    expect(registry.unregisterOwner(oldOwner)).toBe(0);
    expect(registry.getMacro("newMacro")?.handler({} as never)).toBe("new");
    registry.deactivateExtensionGeneration(currentOwner);
    expect(
      registry.registerExtensionMacro(
        definition("lateMacro", "", "late"),
        currentOwner,
      ),
    ).toBe(false);
  });

  test("evicts stale same-owner primaries when a new generation claims an old alias", () => {
    const registry = new MacroRegistry();
    const oldOwner: MacroOwner = { extensionId: "weather", generation: "g1" };
    const newOwner: MacroOwner = { extensionId: "weather", generation: "g2" };
    registry.activateExtensionGeneration(oldOwner);
    expect(
      registry.registerExtensionMacro(
        definition("foo", "extension:weather", "old", ["bar"]),
        oldOwner,
      ),
    ).toBe(true);
    registry.activateExtensionGeneration(newOwner);
    expect(
      registry.registerExtensionMacro(
        definition("bar", "extension:weather", "new"),
        newOwner,
      ),
    ).toBe(true);
    expect(registry.getMacro("foo")).toBeNull();
    expect(registry.getMacro("bar")?.handler({} as never)).toBe("new");
    expect(registry.getMacro("bar")?.name).toBe("bar");
  });

  test("scopes public catalogs to the requested owner", () => {
    const registry = new MacroRegistry();
    const first: MacroOwner = { extensionId: "first", generation: "g1" };
    const second: MacroOwner = { extensionId: "second", generation: "g1" };
    registry.activateExtensionGeneration(first);
    registry.activateExtensionGeneration(second);
    expect(registry.registerMacro(definition("core", "Core", "core"))).toBe(true);
    expect(
      registry.registerExtensionMacro(
        definition("firstOnly", "first", "first"),
        first,
      ),
    ).toBe(true);
    expect(
      registry.registerExtensionMacro(
        definition("secondOnly", "second", "second"),
        second,
      ),
    ).toBe(true);

    const names = (owner?: MacroOwner) =>
      registry
        .getPublicCatalog(owner)
        .categories.flatMap((category) => category.macros.map((macro) => macro.name));
    expect(names()).toEqual(["core"]);
    expect(names(first).sort()).toEqual(["core", "firstOnly"]);
    expect(names(second).sort()).toEqual(["core", "secondOnly"]);
    expect(
      registry
        .getMainCatalog()
        .categories.flatMap((category) => category.macros.map((macro) => macro.name))
        .sort(),
    ).toEqual(["core", "firstOnly", "secondOnly"]);
  });

  test("returns deterministic safe public catalog DTOs", () => {
    const registry = new MacroRegistry();
    const owner: MacroOwner = { extensionId: "weather", generation: "g1" };
    registry.activateExtensionGeneration(owner);

    expect(registry.registerMacro(definition("zeta", "Host", "z"))).toBe(true);
    expect(
      registry.registerExtensionMacro(
        {
          ...definition("alpha", "Host", "a", ["A"]),
          returnType: "integer",
          returns: "number",
          args: [{ name: "count", optional: true, description: "private" }],
          builtIn: true,
        },
        owner,
      ),
    ).toBe(true);
    expect(registry.registerMacro(definition("Beta", "Host", "b"))).toBe(true);

    const catalog = registry.getPublicCatalog(owner);
    expect(catalog).toEqual({
      categories: [
        {
          category: "extension:weather",
          macros: [
            {
              name: "alpha",
              syntax: "{{alpha::[count]}}",
              description: "alpha description",
              args: [{ name: "count", optional: true }],
              returns: "number",
              category: "extension:weather",
            },
          ],
        },
        {
          category: "Host",
          macros: [
            {
              name: "Beta",
              syntax: "{{Beta}}",
              description: "Beta description",
              returns: "string",
              category: "Host",
            },
            {
              name: "zeta",
              syntax: "{{zeta}}",
              description: "zeta description",
              returns: "string",
              category: "Host",
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("handler");
    expect(JSON.stringify(catalog)).not.toContain("builtIn");
    expect(JSON.stringify(catalog)).not.toContain("generation");
  });
  test("rolls back a failed generation to the incumbent without accepting forged tokens", () => {
    const registry = new MacroRegistry();
    const incumbent: MacroOwner = { extensionId: "weather", generation: "incumbent" };
    const replacement: MacroOwner = { extensionId: "weather", generation: "replacement" };
    const forgedPreviousOwner: MacroOwner = { extensionId: "other-extension", generation: "forged" };
    registry.activateExtensionGeneration(incumbent);
    expect(registry.registerExtensionMacro(definition("incumbentMacro", "weather", "incumbent"), incumbent)).toBe(true);
    expect(registry.isActiveOwner(forgedPreviousOwner)).toBe(false);
    expect(registry.getMacro("incumbentMacro")?.handler({} as never)).toBe("incumbent");

    const activation = registry.beginExtensionGeneration(replacement);
    expect(activation).not.toBeNull();
    expect(registry.isActiveOwner(replacement)).toBe(true);
    expect(registry.isActiveOwner(incumbent)).toBe(false);

    const forged = {
      owner: replacement,
      previousOwner: forgedPreviousOwner,
    };
    expect(registry.rollbackExtensionGeneration(forged)).toBe(false);
    expect(registry.isActiveOwner(forgedPreviousOwner)).toBe(false);
    expect(registry.isActiveOwner(replacement)).toBe(true);
    expect(registry.isActiveOwner(incumbent)).toBe(false);
    expect(registry.getMacro("incumbentMacro")?.handler({} as never)).toBe("incumbent");
    const forgedSameExtension = {
      owner: replacement,
      previousOwner: { extensionId: "weather", generation: "incumbent" },
    };
    expect(registry.rollbackExtensionGeneration(forgedSameExtension)).toBe(false);
    expect(registry.isActiveOwner(replacement)).toBe(true);
    expect(registry.isActiveOwner(incumbent)).toBe(false);
    expect(registry.getMacro("incumbentMacro")?.handler({} as never)).toBe("incumbent");
    expect(registry.rollbackExtensionGeneration({ owner: {}, previousOwner: null })).toBe(false);
    expect(registry.isActiveOwner(replacement)).toBe(true);

    if (!activation) throw new Error("generation activation was unexpectedly null");
    expect(registry.rollbackExtensionGeneration(activation)).toBe(true);
    expect(registry.isActiveOwner(incumbent)).toBe(true);
    expect(registry.isActiveOwner(replacement)).toBe(false);
    expect(registry.registerExtensionMacro(definition("restoredMacro", "weather", "restored"), incumbent)).toBe(true);
    expect(registry.getMacro("restoredMacro")?.handler({} as never)).toBe("restored");
  });

  test("does not let a stale rollback overwrite a newer concurrent generation", () => {
    const registry = new MacroRegistry();
    const incumbent: MacroOwner = { extensionId: "weather", generation: "incumbent" };
    const replacement: MacroOwner = { extensionId: "weather", generation: "replacement" };
    const concurrent: MacroOwner = { extensionId: "weather", generation: "concurrent" };
    registry.activateExtensionGeneration(incumbent);
    const activation = registry.beginExtensionGeneration(replacement);
    if (!activation) throw new Error("replacement activation was unexpectedly null");
    expect(registry.beginExtensionGeneration(concurrent)).not.toBeNull();
    expect(registry.registerExtensionMacro(definition("concurrentMacro", "weather", "concurrent"), concurrent)).toBe(true);
    expect(registry.getMacro("concurrentMacro")?.handler({} as never)).toBe("concurrent");
    expect(registry.rollbackExtensionGeneration(activation)).toBe(false);
    expect(registry.isActiveOwner(concurrent)).toBe(true);
    expect(registry.isActiveOwner(replacement)).toBe(false);
    expect(registry.isActiveOwner(incumbent)).toBe(false);
    expect(registry.isOwnedMacro("concurrentMacro", concurrent)).toBe(true);
    expect(registry.isOwnedMacro("concurrentMacro", replacement)).toBe(false);
    expect(registry.getMacro("concurrentMacro")?.handler({} as never)).toBe("concurrent");
  });
});
