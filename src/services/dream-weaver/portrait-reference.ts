import type { DW_DRAFT_V1, DreamWeaverVisualReference } from "../../types/dream-weaver";

export interface AcceptedPortraitReference {
  assetId: string;
  reference: DreamWeaverVisualReference;
}

export function getAcceptedPortraitReference(
  draft: Pick<DW_DRAFT_V1, "visual_assets"> | null | undefined,
): AcceptedPortraitReference | null {
  const portrait = draft?.visual_assets?.find((asset) =>
    asset?.asset_type === "card_portrait" &&
    Array.isArray(asset.references) &&
    asset.references.length > 0,
  );

  const reference = portrait?.references?.[0];
  if (!portrait || !reference) return null;

  return {
    assetId: portrait.id,
    reference,
  };
}

export function isPersistablePortraitDataUrl(
  reference: Pick<DreamWeaverVisualReference, "image_url"> | null | undefined,
): boolean {
  return typeof reference?.image_url === "string" && reference.image_url.startsWith("data:image/");
}

export function applyAcceptedPortraitImageId(
  draft: DW_DRAFT_V1,
  assetId: string,
  imageId: string,
): DW_DRAFT_V1 {
  return {
    ...draft,
    visual_assets: (draft.visual_assets ?? []).map((asset) => {
      if (asset.id !== assetId || asset.references.length === 0) return asset;
      const [primaryReference, ...rest] = asset.references;
      return {
        ...asset,
        references: [
          {
            ...primaryReference,
            image_id: imageId,
            image_url: undefined,
          },
          ...rest,
        ],
      };
    }),
    image_assets: (draft.image_assets ?? []).map((asset) =>
      asset.id === assetId
        ? {
            ...asset,
            imageId,
            imageUrl: null,
          }
        : asset,
    ),
  };
}
