import * as apiClient from './client'

export interface SavedPrompt {
  id: string
  user_id: string
  name: string
  prompt: string
  negative_prompt: string
  created_at: number
  updated_at: number
}

export const savedPromptsApi = {
  list() {
    return apiClient.get<SavedPrompt[]>('/dream-weaver/saved-prompts')
  },
  create(input: { name: string; prompt: string; negative_prompt?: string }) {
    return apiClient.post<SavedPrompt>('/dream-weaver/saved-prompts', input)
  },
  update(id: string, input: { name?: string; prompt?: string; negative_prompt?: string }) {
    return apiClient.put<SavedPrompt>(`/dream-weaver/saved-prompts/${id}`, input)
  },
  delete(id: string) {
    return apiClient.del<{ success: boolean }>(`/dream-weaver/saved-prompts/${id}`)
  },
}
