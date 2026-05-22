import { describe, expect, test } from "bun:test";
import {
  applyPersonaAddonStates,
  getChatPersonaAddonStates,
} from "./persona-addon-states";
import type { Persona } from "../types/persona";

describe("persona add-on states", () => {
  test("reads sanitized add-on states for the active persona from chat metadata", () => {
    expect(
      getChatPersonaAddonStates(
        {
          persona_addon_states: {
            personaA: {
              addonOn: true,
              addonOff: false,
              ignoredString: "true",
              ignoredNull: null,
            },
            personaB: { other: true },
          },
        },
        "personaA",
      ),
    ).toEqual({ addonOn: true, addonOff: false });
  });

  test("applies persona and attached global add-on overrides", () => {
    const persona: Persona = {
      id: "personaA",
      name: "Persona A",
      title: "",
      description: "",
      subjective_pronoun: "",
      objective_pronoun: "",
      possessive_pronoun: "",
      avatar_path: null,
      image_id: null,
      is_default: false,
      attached_world_book_id: null,
      folder: "",
      metadata: {
        addons: [
          { id: "personaAddon", enabled: false },
          { id: "unchangedPersonaAddon", enabled: true },
        ],
        attached_global_addons: [
          { id: "globalAddon", enabled: true },
          { id: "unchangedGlobalAddon", enabled: false },
        ],
      },
      created_at: 1,
      updated_at: 1,
    };

    expect(
      applyPersonaAddonStates(persona, {
        personaAddon: true,
        globalAddon: false,
      })?.metadata,
    ).toMatchObject({
      addons: [
        { id: "personaAddon", enabled: true },
        { id: "unchangedPersonaAddon", enabled: true },
      ],
      attached_global_addons: [
        { id: "globalAddon", enabled: false },
        { id: "unchangedGlobalAddon", enabled: false },
      ],
    });
  });
});
