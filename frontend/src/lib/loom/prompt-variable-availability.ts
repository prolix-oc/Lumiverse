import type { PromptBlock } from './types'

type PromptVariableBlock = Pick<PromptBlock, 'variables'>

export type PromptVariablesAvailability = {
  presetId: string
  registryUpdatedAt: number | null
  hasDefinitions: boolean
}

export function hasPromptVariableDefinitions(
  blocks: readonly PromptVariableBlock[] | null | undefined,
): boolean {
  return blocks?.some((block) => Array.isArray(block.variables) && block.variables.length > 0) ?? false
}

export async function inspectPromptVariablesAvailability({
  presetId,
  registryUpdatedAt,
  loadBlocks,
  isCurrent,
}: {
  presetId: string
  registryUpdatedAt: number | null
  loadBlocks: () => Promise<readonly PromptVariableBlock[] | null | undefined>
  isCurrent: () => boolean
}): Promise<PromptVariablesAvailability | null> {
  const blocks = await loadBlocks()
  if (!isCurrent()) return null

  return {
    presetId,
    registryUpdatedAt,
    hasDefinitions: hasPromptVariableDefinitions(blocks),
  }
}
