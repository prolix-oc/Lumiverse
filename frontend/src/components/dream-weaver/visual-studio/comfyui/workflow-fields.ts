export interface ComfyWorkflowField {
  fieldName: string
  currentValue: unknown
}

export function getUiWorkflowFields(
  workflow: Record<string, any> | null | undefined,
  nodeId: string,
): ComfyWorkflowField[] {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : []
  const node = nodes.find((candidate: any) => String(candidate?.id) === nodeId)
  if (!node || !Array.isArray(node.inputs)) return []

  const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : []
  let widgetIndex = 0

  const fields: ComfyWorkflowField[] = []
  for (const input of node.inputs) {
    if (!input || typeof input !== 'object' || typeof input.name !== 'string') continue

    const hasWidget = !!input.widget && typeof input.widget === 'object'
    const isLinked = input.link !== null && input.link !== undefined

    if (!hasWidget && isLinked) continue

    const currentValue = hasWidget ? widgetValues[widgetIndex++] : null
    fields.push({
      fieldName: input.name,
      currentValue,
    })
  }

  return fields
}

export function getApiWorkflowFields(
  workflow: Record<string, any> | null | undefined,
  nodeId: string,
): ComfyWorkflowField[] {
  const node = workflow?.[nodeId]
  if (!node || typeof node.inputs !== 'object') return []

  const fields: ComfyWorkflowField[] = []
  for (const [name, value] of Object.entries(node.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') continue
    fields.push({ fieldName: name, currentValue: value })
  }
  return fields
}
