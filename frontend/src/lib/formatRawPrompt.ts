import type { DryRunResponse, DryRunMessage } from '@/api/generate'

export type RawPromptView = 'text' | 'json'

export interface RawPromptInput {
  messages: DryRunMessage[]
  parameters?: Record<string, any>
  assistantPrefill?: string
  model?: string
  provider?: string
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
  const payload: Record<string, any> = {
    messages: input.messages,
  }
  if (input.assistantPrefill) payload.assistantPrefill = input.assistantPrefill
  if (input.parameters) payload.parameters = input.parameters
  if (input.model) payload.model = input.model
  if (input.provider) payload.provider = input.provider
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
  }
}
