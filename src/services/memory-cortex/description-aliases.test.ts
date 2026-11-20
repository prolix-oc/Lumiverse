import { expect, test } from "bun:test";

import { buildSidecarAliasList, extractDescriptionAliases } from "./index";

test("extracts structured nickname and aliases fields from character cards", () => {
  const aliases = extractDescriptionAliases(
    "Aurelia Voss",
    `
**Nickname:** Lia
Aliases: "The Nightingale", Voss
Moniker: The Silver Fox
`,
  );

  expect(aliases.get("lia")).toBe("Aurelia Voss");
  expect(aliases.get("the nightingale")).toBe("Aurelia Voss");
  expect(aliases.get("voss")).toBe("Aurelia Voss");
  expect(aliases.get("the silver fox")).toBe("Aurelia Voss");
});

test("threads card-defined nicknames into the sidecar's canonical alias list", () => {
  const descriptionAliases = extractDescriptionAliases("Aurelia Voss", "Nickname: Lia");

  expect(buildSidecarAliasList(descriptionAliases, [])).toEqual([
    { alias: "lia", canonicalName: "Aurelia Voss" },
  ]);
});
