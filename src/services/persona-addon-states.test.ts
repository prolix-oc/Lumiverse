import { describe, expect, test } from "bun:test";
import {
  applyPersonaAddonStates,
  getChatPersonaAddonStates,
  getChatPersonaAddonToggleOrder,
  resolvePersonaAvatarInfo,
  withChatPersonaAddonState,
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

  test("records toggle recency alongside the existing boolean override map", () => {
    const first = withChatPersonaAddonState({}, "personaA", "human", true);
    const second = withChatPersonaAddonState(first, "personaA", "furry", true);
    const third = withChatPersonaAddonState(second, "personaA", "human", false);

    expect(getChatPersonaAddonStates(third, "personaA")).toEqual({ human: false, furry: true });
    expect(getChatPersonaAddonToggleOrder(third, "personaA")).toEqual(["furry", "human"]);
    expect(third.persona_addon_avatar_versions.personaA).toEqual(expect.any(String));
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
      is_narrator: false,
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

  test("uses the most recently toggled enabled add-on avatar, then falls back", () => {
    const persona: Persona = {
      id: "personaA",
      name: "Persona A",
      title: "",
      description: "",
      subjective_pronoun: "",
      objective_pronoun: "",
      possessive_pronoun: "",
      avatar_path: "base.png",
      image_id: "base-image",
      is_default: false,
      is_narrator: false,
      attached_world_book_id: null,
      folder: "",
      metadata: {
        addons: [
          { id: "human", enabled: true, avatar_image_id: "human-image" },
          { id: "furry", enabled: true, avatar_image_id: "furry-image", avatar_crop_image_id: "furry-crop" },
        ],
      },
      created_at: 1,
      updated_at: 1,
    };

    expect(resolvePersonaAvatarInfo(persona, undefined, ["human", "furry"])).toMatchObject({
      image_id: "furry-image",
      avatar_crop_image_id: "furry-crop",
      addon_id: "furry",
    });
    expect(resolvePersonaAvatarInfo(persona, { human: true, furry: false }, ["human", "furry"])).toMatchObject({
      image_id: "human-image",
      addon_id: "human",
    });
    expect(resolvePersonaAvatarInfo(persona, { human: false, furry: false }, ["human", "furry"])).toEqual({
      image_id: "base-image",
      avatar_path: "base.png",
      avatar_crop_image_id: null,
    });
  });
});
