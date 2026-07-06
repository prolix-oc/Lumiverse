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

  const multiLoraWorkflow = {
    "10": {
      class_type: "LoraLoader",
      inputs: {
        lora_name: "embedded-a.safetensors",
        strength_model: 1.0,
        strength_clip: 0.9,
      },
    },
    "20": {
      class_type: "LoraLoader",
      inputs: {
        lora_name: "embedded-b.safetensors",
        strength_model: 0.8,
        strength_clip: 0.7,
      },
    },
  };

  const multiLoraMappings: ComfyUIFieldMapping[] = [
    { nodeId: "10", fieldName: "lora_name", mappedAs: "lora_name", autoDetected: true },
    { nodeId: "10", fieldName: "strength_model", mappedAs: "lora_strength_model", autoDetected: true },
    { nodeId: "10", fieldName: "strength_clip", mappedAs: "lora_strength_clip", autoDetected: true },
    { nodeId: "20", fieldName: "lora_name", mappedAs: "lora_name", autoDetected: true },
    { nodeId: "20", fieldName: "strength_model", mappedAs: "lora_strength_model", autoDetected: true },
    { nodeId: "20", fieldName: "strength_clip", mappedAs: "lora_strength_clip", autoDetected: true },
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

  test("writes ordered lora entries into multiple LoraLoader nodes", () => {
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {
      loras: [
        { lora_name: "first.safetensors", weight_model: 0.45, weight_clip: 0.35 },
        { lora_name: "second.safetensors", weight_model: 0.75, weight_clip: 0.65 },
      ],
    });

    expect(patched["10"].inputs.lora_name).toBe("first.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.45);
    expect(patched["10"].inputs.strength_clip).toBe(0.35);
    expect(patched["20"].inputs.lora_name).toBe("second.safetensors");
    expect(patched["20"].inputs.strength_model).toBe(0.75);
    expect(patched["20"].inputs.strength_clip).toBe(0.65);
  });

  test("skips missing mapped LoRA nodes without consuming ordered lora entries", () => {
    const patched = patchWorkflow(multiLoraWorkflow, [
      { nodeId: "999", fieldName: "lora_name", mappedAs: "lora_name", autoDetected: true },
      ...multiLoraMappings,
    ], {
      loras: [
        { lora_name: "first.safetensors", weight_model: 0.45, weight_clip: 0.35 },
        { lora_name: "second.safetensors", weight_model: 0.75, weight_clip: 0.65 },
      ],
    });

    expect(patched["10"].inputs.lora_name).toBe("first.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.45);
    expect(patched["10"].inputs.strength_clip).toBe(0.35);
    expect(patched["20"].inputs.lora_name).toBe("second.safetensors");
    expect(patched["20"].inputs.strength_model).toBe(0.75);
    expect(patched["20"].inputs.strength_clip).toBe(0.65);
    expect(patched["999"]).toBeUndefined();
  });

  test("drops extra lora entries beyond the mapped LoraLoader nodes", () => {
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {
      loras: [
        { lora_name: "kept-a.safetensors", weight_model: 0.2, weight_clip: 0.25 },
        { lora_name: "kept-b.safetensors", weight_model: 0.4, weight_clip: 0.45 },
        { lora_name: "dropped.safetensors", weight_model: 0.9, weight_clip: 0.95 },
      ],
    });

    expect(patched["10"].inputs.lora_name).toBe("kept-a.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.2);
    expect(patched["10"].inputs.strength_clip).toBe(0.25);
    expect(patched["20"].inputs.lora_name).toBe("kept-b.safetensors");
    expect(patched["20"].inputs.strength_model).toBe(0.4);
    expect(patched["20"].inputs.strength_clip).toBe(0.45);
  });

  test("leaves extra mapped LoRA nodes embedded when fewer lora entries are provided", () => {
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {
      loras: [{ lora_name: "only.safetensors", weight_model: 0.55 }],
      lora_name: "legacy-should-not-fill.safetensors",
      lora_strength_model: 0.1,
      lora_strength_clip: 0.1,
    });

    expect(patched["10"].inputs.lora_name).toBe("only.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.55);
    expect(patched["10"].inputs.strength_clip).toBe(0.55);
    expect(patched["20"].inputs.lora_name).toBe("embedded-b.safetensors");
    expect(patched["20"].inputs.strength_model).toBe(0.8);
    expect(patched["20"].inputs.strength_clip).toBe(0.7);
  });

  test("keeps legacy lora fields applying to every mapped LoraLoader node", () => {
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {
      lora_name: "legacy.safetensors",
      lora_strength_model: 0.33,
      lora_strength_clip: 0.22,
    });

    expect(patched["10"].inputs.lora_name).toBe("legacy.safetensors");
    expect(patched["10"].inputs.strength_model).toBe(0.33);
    expect(patched["10"].inputs.strength_clip).toBe(0.22);
    expect(patched["20"].inputs.lora_name).toBe("legacy.safetensors");
    expect(patched["20"].inputs.strength_model).toBe(0.33);
    expect(patched["20"].inputs.strength_clip).toBe(0.22);
  });

  test("leaves the workflow untouched when no lora values are provided", () => {
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {});

    expect(patched).toEqual(multiLoraWorkflow);
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
    const before = JSON.parse(JSON.stringify(multiLoraWorkflow));
    const patched = patchWorkflow(multiLoraWorkflow, multiLoraMappings, {
      loras: [{ lora_name: "other.safetensors", weight_model: 0.3, weight_clip: 0.3 }],
    });

    expect(multiLoraWorkflow).toEqual(before);
    expect(patched).not.toBe(multiLoraWorkflow);
    expect(patched["10"]).not.toBe(multiLoraWorkflow["10"]);
    expect(patched["10"].inputs).not.toBe(multiLoraWorkflow["10"].inputs);
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
