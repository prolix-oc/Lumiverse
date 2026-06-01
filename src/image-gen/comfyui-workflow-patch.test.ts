import { describe, expect, test } from "bun:test";
import { patchWorkflow, type ComfyUIFieldMapping } from "./comfyui-workflow-patch";
import { detectInjectionPoints } from "./comfyui-workflow-parser";

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

describe("patchWorkflow — img2img semantics", () => {
  const img2imgWorkflow = {
    "3": {
      class_type: "KSampler",
      inputs: { seed: 0, steps: 20, denoise: 1.0, latent_image: ["11", 0] },
    },
    "10": {
      class_type: "LoadImage",
      inputs: { image: "placeholder.png" },
    },
    "11": {
      class_type: "VAEEncode",
      inputs: { pixels: ["10", 0], vae: ["4", 2] },
    },
  };

  const mappings: ComfyUIFieldMapping[] = [
    { nodeId: "10", fieldName: "image", mappedAs: "init_image", autoDetected: true },
    { nodeId: "3", fieldName: "denoise", mappedAs: "denoise", autoDetected: true },
  ];

  test("injects the uploaded init image filename and denoise", () => {
    const patched = patchWorkflow(img2imgWorkflow, mappings, {
      init_image: "lumiverse-init-abc.png",
      denoise: 0.55,
    });
    expect(patched["10"].inputs.image).toBe("lumiverse-init-abc.png");
    expect(patched["3"].inputs.denoise).toBe(0.55);
  });

  test("leaves the embedded LoadImage default when no init image is supplied", () => {
    const patched = patchWorkflow(img2imgWorkflow, mappings, { denoise: 0.6 });
    expect(patched["10"].inputs.image).toBe("placeholder.png");
    expect(patched["3"].inputs.denoise).toBe(0.6);
  });
});

describe("detectInjectionPoints — img2img hints", () => {
  test("suggests init_image for LoadImage.image and denoise for KSampler.denoise", () => {
    const points = detectInjectionPoints({
      "3": {
        class_type: "KSampler",
        inputs: { seed: 0, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 0.6 },
      },
      "10": {
        class_type: "LoadImage",
        inputs: { image: "input.png" },
      },
    });

    const initImage = points.find((p) => p.nodeId === "10" && p.fieldName === "image");
    expect(initImage?.suggestedAs).toBe("init_image");

    const denoise = points.find((p) => p.nodeId === "3" && p.fieldName === "denoise");
    expect(denoise?.suggestedAs).toBe("denoise");
  });
});
