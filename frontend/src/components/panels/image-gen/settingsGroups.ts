/** Keep unknown schema groups reachable rather than assuming a fixed provider list. */
export function settingsGroupView(name: string): 'generation' | 'sources' | 'advanced' {
  if (/^(models?|checkpoints?|samplers?)$/i.test(name)) return 'generation'
  if (/^(references?|sources?|img2img|image[_-]?to[_-]?image)$/i.test(name)) return 'sources'
  return 'advanced'
}
