import type { ThemePackAsset } from './themePack'

interface ThemePackAssetClient<T extends { id: string }> {
  upload(file: File, options: {
    bundleId: string; slug: string; tags: string[]; metadata: Record<string, unknown>
  }): Promise<T>
  delete(id: string): Promise<void>
}

/** Stage a complete asset snapshot, removing partial uploads on failure. */
export async function uploadThemePackAssets<T extends { id: string }>(
  assets: readonly ThemePackAsset[],
  bundleId: string,
  client: ThemePackAssetClient<T>,
): Promise<T[]> {
  const uploaded: T[] = []
  try {
    for (const asset of assets) {
      const bytes = Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0))
      uploaded.push(await client.upload(new File([bytes], asset.originalFilename, { type: asset.mimeType }), {
        bundleId, slug: asset.slug, tags: asset.tags, metadata: asset.metadata,
      }))
    }
    return uploaded
  } catch (error) {
    await Promise.all(uploaded.map((asset) => client.delete(asset.id).catch(() => {})))
    throw error
  }
}
