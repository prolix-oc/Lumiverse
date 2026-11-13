import { expect, test } from "bun:test";
import { imageInputMechanism } from "./image-input";

test("source-image support respects model restrictions and unknown providers", () => {
  for (const [provider, model] of [["stability", "core"], ["ideogram", "ideogram-2a"], ["fal", "fal-ai/flux/dev"], ["novelai", "nai-diffusion-5"], ["toString", ""], ["replicate", "model"]]) {
    expect(imageInputMechanism(provider, model)).toBeNull();
  }
  expect(imageInputMechanism("stability", "ultra")).toBe("edit");
  expect(imageInputMechanism("ideogram", "ideogram-4-5")).toBe("edit");
  expect(imageInputMechanism("fal", "fal-ai/flux/dev/image-to-image")).toBe("edit");
});
