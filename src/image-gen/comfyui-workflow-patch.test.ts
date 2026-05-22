import { describe, expect, test } from "bun:test";
import { patchWorkflow, type ComfyUIFieldMapping } from "./comfyui-workflow-patch";

describe("patchWorkflow — LoRA semantics", () => {
  const baseWorkflow = {
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: "placeholder" },
    },
    "10": {
      class_type: "LoraLoader",
      inputs: {
        lora_name: "default.safetensors",
        strength_model: 1.0,
        strength_clip: 1.0,
      },
    },
  };

  const mappings: ComfyUIFieldMapping[] = [
    { nodeId: "3", fieldName: "text", mappedAs: "positive_prompt", autoDetected: true },
    { nodeId: "10", fieldName: "lora_name", mappedAs: "lora_name", autoDetected: true },
    { nodeId: "10", fieldName: "strength_model", mappedAs: "lora_strength_model", autoDetected: true },
    { nodeId: "10", fieldName: "strength_clip", mappedAs: "lora_strength_clip", autoDetected: true },
  ];

  test("writes lora_name/strengths into LoraLoader inputs", () => {
    const patched = patchWorkflow(baseWorkflow, mappings, {
      positive_prompt: "a portrait",
      lora_name: "aerith_v3.safetensors",
      lora_strength_model: 0.85,
      lora_strength_clip: 0.7,
    });
    expect(patched["10"].inputs.lora_name).toBe("aerith_v3.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.85);
    expect(patched["10"].inputs.strength_clip).toBe(0.7);
    expect(patched["3"].inputs.text).toBe("a portrait");
  });

  test("leaves workflow values untouched when LoRA values are absent", () => {
    const patched = patchWorkflow(baseWorkflow, mappings, {
      positive_prompt: "a portrait",
    });
    expect(patched["10"].inputs.lora_name).toBe("default.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(1.0);
    expect(patched["10"].inputs.strength_clip).toBe(1.0);
  });

  test("does not mutate the original workflow", () => {
    const before = JSON.parse(JSON.stringify(baseWorkflow));
    patchWorkflow(baseWorkflow, mappings, {
      lora_name: "other.safetensors",
      lora_strength_model: 0.3,
      lora_strength_clip: 0.3,
    });
    expect(baseWorkflow).toEqual(before);
  });

  test("ignores mappings pointing at non-existent nodes without throwing", () => {
    const patched = patchWorkflow(baseWorkflow, [
      ...mappings,
      { nodeId: "999", fieldName: "lora_name", mappedAs: "lora_name" },
    ], {
      lora_name: "x.safetensors",
      lora_strength_model: 0.5,
      lora_strength_clip: 0.5,
    });
    expect(patched["10"].inputs.lora_name).toBe("x.safetensors");
    expect(patched["999"]).toBeUndefined();
  });
});
