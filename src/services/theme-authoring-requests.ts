export const THEME_AUTHORING_ACCESS = {
  state: 'read',
  validate: 'read',
  export_current: 'read',
  export_draft: 'read',
  asset_list: 'read',
  asset_download: 'read',
  asset_create_bundle: 'read',
  install: 'write',
  backup: 'write',
  restore: 'write',
  import: 'write',
  asset_upload: 'write',
  asset_update: 'write',
  asset_delete: 'write',
  asset_optimize: 'write',
} as const;
const fields: Record<keyof typeof THEME_AUTHORING_ACCESS, readonly string[]> = {
  state: [],
  validate: ['draft'],
  export_current: [],
  export_draft: ['draft'],
  asset_list: ['bundleId'],
  asset_download: ['id'],
  asset_create_bundle: [],
  install: ['draft', 'options'],
  backup: ['name'],
  restore: ['backupId', 'expectedRevision'],
  import: ['pack'],
  asset_upload: ['bundleId', 'name', 'mimeType', 'bytes', 'slug', 'tags', 'metadata'],
  asset_update: ['id', 'patch'],
  asset_delete: ['id'],
  asset_optimize: ['id'],
};
function assertAllowedFields(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !allowed.includes(key) && (value as Record<string, unknown>)[key] !== undefined,
    )
  )
    throw new Error('Invalid theme arguments.');
}
export function validateThemeRequest(
  operation: string,
  args: unknown,
): asserts args is Record<string, unknown> {
  if (!Object.hasOwn(fields, operation)) throw new Error('Unknown theme operation.');
  assertAllowedFields(args, fields[operation as keyof typeof fields]);
  if (args.options !== undefined) {
    assertAllowedFields(args.options, ['expectedRevision', 'mode', 'apply', 'saveToLibrary']);
    for (const name of ['apply', 'saveToLibrary'])
      if (args.options[name] !== undefined && typeof args.options[name] !== 'boolean')
        throw new Error('Invalid theme install option.');
  }
  if (operation === 'asset_update' || args.patch !== undefined)
    assertAllowedFields(args.patch, ['slug', 'tags', 'metadata']);
  const patch = args.patch ?? args;
  if (patch && typeof patch === 'object') {
    const value = patch as Record<string, unknown>;
    if (
      value.slug !== undefined &&
      (typeof value.slug !== 'string' || !value.slug || value.slug.length > 500)
    )
      throw new Error('Invalid theme asset slug.');
    if (
      value.tags !== undefined &&
      (!Array.isArray(value.tags) ||
        value.tags.length > 32 ||
        value.tags.some((tag) => typeof tag !== 'string' || tag.length > 200))
    )
      throw new Error('Invalid theme asset tags.');
    if (
      value.metadata !== undefined &&
      (!value.metadata ||
        typeof value.metadata !== 'object' ||
        Array.isArray(value.metadata) ||
        JSON.stringify(value.metadata).length > 64000)
    )
      throw new Error('Invalid theme asset metadata.');
  }
}
