/** Hydrogen and Neon support low/medium/high/xhigh, without minimal.
 * https://ai.google.dev/gemini-api/docs/thinking
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
 */
export function supportsGeminiXhigh(model: string | null | undefined): boolean {
  return !!model && /(?:^|\/)gemini-4-(?:hydrogen|neon)(?=$|[-.:@])/i.test(model.trim());
}
