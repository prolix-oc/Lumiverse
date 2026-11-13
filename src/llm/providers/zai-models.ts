/** Z.ai's documented GLM-5.3-Flash vision family, including FlashX variants. */
export function isZaiVisionModel(model: string): boolean {
  return /^glm-5\.3-flash(?:x(?:-legal)?)?$/i.test(model);
}
