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
    return { ...script, preset_id: presetId }
  })
}
