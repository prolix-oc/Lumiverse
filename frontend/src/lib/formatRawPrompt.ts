import type { DryRunResponse, DryRunMessage } from '@/api/generate'
import type { LoomPromptInspectionV1 } from '@/types/agent-runtime'

export type RawPromptView = 'text' | 'json'

export interface RawPromptInput {
  messages: DryRunMessage[]
  parameters?: Record<string, unknown>
  assistantPrefill?: string
  model?: string
  provider?: string
  assemblySurface?: 'RESPONSE' | 'WORK'
  source?: 'stored_breakdown' | 'response_dry_run'
  target?: {
    generationType: string
    messageId: string | null
    swipeId: number | null
  }
  loomPromptInspection?: LoomPromptInspectionV1
}

function formatContentPartsSummary(message: DryRunMessage): string {
  const parts = message.contentParts?.filter((part) => part.count > 0) ?? []
  if (parts.length === 0) return ''
  return parts
    .map((part) => `${part.type} x${part.count}`)
    .join(' | ')
}

function formatMessagesText(messages: DryRunMessage[]): string {
  return messages
    .map((m, i) => {
      const contentParts = formatContentPartsSummary(m)
      const header = contentParts
        ? `### [${i + 1}] ${m.role.toUpperCase()} (${contentParts})`
        : `### [${i + 1}] ${m.role.toUpperCase()}`
      const sections = [header, m.content]
      if (m.reasoning?.trim()) {
        sections.push(`--- REASONING ---\n${m.reasoning}`)
      }
      return sections.join('\n\n')
    })
    .join('\n\n')
}

export function formatRawPromptText(input: RawPromptInput): string {
  const parts: string[] = []

  if (input.provider || input.model) {
    const header = [input.provider, input.model].filter(Boolean).join(' / ')
    parts.push(`# ${header}`)
  }
  if (input.assemblySurface || input.source) {
    parts.push([
      '### ASSEMBLY',
      `Surface: ${input.assemblySurface ?? 'UNKNOWN'}`,
      `Source: ${input.source ?? 'unknown'}`,
    ].join('\n'))
  }

  if (input.target) {
    parts.push([
      '### TARGET',
      `Generation type: ${input.target.generationType}`,
      `Message ID: ${input.target.messageId ?? 'none'}`,
      `Swipe ID: ${input.target.swipeId ?? 'none'}`,
    ].join('\n'))
  }

  if (input.loomPromptInspection) {
    parts.push(`### LOOM INCLUSION / OMISSION\n${JSON.stringify(input.loomPromptInspection, null, 2)}`)
  }

  parts.push(formatMessagesText(input.messages))

  if (input.assistantPrefill) {
    parts.push(`### ASSISTANT PREFILL\n${input.assistantPrefill}`)
  }

  if (input.parameters && Object.keys(input.parameters).length > 0) {
    parts.push(`### PARAMETERS\n${JSON.stringify(input.parameters, null, 2)}`)
  }

  return parts.join('\n\n')
}

export function formatRawPromptJson(input: RawPromptInput): string {
  const payload: Record<string, unknown> = {
    messages: input.messages,
  }
  if (input.assistantPrefill) payload.assistantPrefill = input.assistantPrefill
  if (input.parameters) payload.parameters = input.parameters
  if (input.model) payload.model = input.model
  if (input.provider) payload.provider = input.provider
  if (input.assemblySurface) payload.assemblySurface = input.assemblySurface
  if (input.source) payload.source = input.source
  if (input.target) payload.target = input.target
  if (input.loomPromptInspection) payload.loomPromptInspection = input.loomPromptInspection
  return JSON.stringify(payload, null, 2)
}

export function formatRawPrompt(input: RawPromptInput, view: RawPromptView): string {
  return view === 'json' ? formatRawPromptJson(input) : formatRawPromptText(input)
}

export function dryRunToRawPromptInput(res: DryRunResponse): RawPromptInput {
  return {
    messages: res.messages,
    parameters: res.parameters,
    assistantPrefill: res.assistantPrefill,
    model: res.model,
    provider: res.provider,
    assemblySurface: res.assemblySurface,
    source: 'response_dry_run',
    loomPromptInspection: res.loomPromptInspection,
  }
}
