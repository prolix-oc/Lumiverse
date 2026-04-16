import type { ComfyUIWorkflowConfig } from '@/api/dream-weaver'

export type ComfyWorkflowJsonFormat = 'ui_workflow' | 'api_prompt' | 'unknown'

export function detectComfyWorkflowJsonFormat(
  workflow: Record<string, any> | null | undefined,
): ComfyWorkflowJsonFormat {
  if (!workflow || typeof workflow !== 'object') return 'unknown'
  if (Array.isArray((workflow as { nodes?: unknown }).nodes)) return 'ui_workflow'

  const objectEntries = Object.values(workflow).filter(isPlainObject)
  if (objectEntries.length === 0) return 'unknown'

  return objectEntries.every(looksLikeApiPromptNode) ? 'api_prompt' : 'unknown'
}

export function resolveComfyGraphFormat(
  config: ComfyUIWorkflowConfig | null | undefined,
): 'ui_workflow' | 'api_prompt' {
  const detectedFormat = detectComfyWorkflowJsonFormat(config?.workflow_json)
  if (detectedFormat !== 'unknown') return detectedFormat
  return config?.workflow_format ?? 'api_prompt'
}

export function resolveComfyApiWorkflow(
  config: ComfyUIWorkflowConfig | null | undefined,
): Record<string, any> | null {
  if (!config) return null
  if (isPlainObject(config.workflow_api_json)) {
    return config.workflow_api_json
  }

  if (resolveComfyGraphFormat(config) === 'api_prompt' && isPlainObject(config.workflow_json)) {
    return config.workflow_json
  }

  return null
}

export function hasComfyWorkflowFormatMismatch(
  config: ComfyUIWorkflowConfig | null | undefined,
): boolean {
  if (!config) return false
  const detectedFormat = detectComfyWorkflowJsonFormat(config.workflow_json)
  return detectedFormat !== 'unknown' && detectedFormat !== config.workflow_format
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeApiPromptNode(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const node = value as { class_type?: unknown; inputs?: unknown }
  return typeof node.class_type === 'string' && !!node.inputs && typeof node.inputs === 'object'
}
