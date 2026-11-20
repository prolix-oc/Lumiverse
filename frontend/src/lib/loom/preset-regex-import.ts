/**
 * Rebind regexes embedded in an imported preset to the newly-created preset.
 *
 * Older and third-party exports can carry a nested `preset_id`. The regex
 * import endpoint only uses its top-level preset id when a script does not
 * already have one, so forwarding that stale id makes the script inactive and
 * prevents the active-preset toggle from changing it.
 */
export function bindImportedRegexesToPreset(scripts: unknown[], presetId: string): unknown[] {
  return scripts.map((script) => {
    if (!script || typeof script !== 'object' || Array.isArray(script)) return script
    const record = script as Record<string, unknown>
    const importedScriptId = typeof record.script_id === 'string' ? record.script_id.trim() : ''
    const sourceMetadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {}
    return {
      ...record,
      // A publisher's script id is useful provenance, but is globally unique
      // in a user's library. Keeping it here would overwrite an existing local
      // or LumiHub regex when the containing preset is imported again.
      script_id: '',
      metadata: importedScriptId
        ? { ...sourceMetadata, imported_script_id: importedScriptId }
        : sourceMetadata,
      preset_id: presetId,
    }
  })
}
