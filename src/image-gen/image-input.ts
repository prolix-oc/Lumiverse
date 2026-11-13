/** Browser-safe source-image capabilities shared by scene generation and Weaver. */
const IMAGE_INPUT: Record<string, "edit" | "init" | "reference"> = {
  comfyui: "init", swarmui: "init", google_gemini: "edit", openrouter: "edit",
  openai: "edit", sdapi: "init", xai: "edit", ideogram: "edit", bfl: "edit",
  fal: "edit", together: "edit", stability: "edit", runware: "init",
  novelai: "reference", nanogpt: "edit",
};

export function imageInputMechanism(provider: string, model = ""): "edit" | "init" | "reference" | null {
  if (provider === "novelai" && model.startsWith("nai-diffusion-5")) return null;
  if (provider === "stability" && (!model || model === "core")) return null;
  if (provider === "ideogram" && model && !/^ideogram-(3|4)/.test(model)) return null;
  if (provider === "fal" && [
    "fal-ai/flux/schnell", "fal-ai/flux/dev", "fal-ai/flux-pro/v1.1",
    "fal-ai/flux-pro/v1.1-ultra", "fal-ai/stable-diffusion-v35-large",
  ].includes(model)) return null;
  return Object.hasOwn(IMAGE_INPUT, provider) ? IMAGE_INPUT[provider] : null;
}
