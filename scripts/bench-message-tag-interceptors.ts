import {
  registerTagInterceptor,
  stripMessageTags,
  unregisterTagInterceptorsByExtension,
} from '../frontend/src/lib/spindle/message-interceptors'

function measure(
  label: string,
  tags: number,
  content: string,
  isStreaming: boolean,
  iterations = 1_000,
): { label: string; milliseconds: number; intercepts: number } {
  for (let i = 0; i < tags; i += 1) {
    registerTagInterceptor(`bench-${i}`, `Bench ${i}`, {
      tagName: `tag${i}`,
      removeFromMessage: true,
    }, () => {})
  }

  for (let i = 0; i < 100; i += 1) stripMessageTags(content, { messageId: 'bench', isStreaming })
  const startedAt = performance.now()
  let intercepts = 0
  for (let i = 0; i < iterations; i += 1) {
    intercepts += stripMessageTags(content, { messageId: 'bench', isStreaming }).intercepts.length
  }
  const milliseconds = performance.now() - startedAt
  for (let i = 0; i < tags; i += 1) unregisterTagInterceptorsByExtension(`bench-${i}`)

  return { label, milliseconds: Number(milliseconds.toFixed(2)), intercepts }
}

const filler = 'plain message text '.repeat(1_000)
const markupFiller = '<div>ordinary markup without intercepted tags</div>'.repeat(400)
const oneTag = Array.from(
  { length: 100 },
  (_, index) => `<tag0 kind="x">payload ${index}</tag0>`,
).join(' ') + filler
const manyTags = Array.from(
  { length: 20 },
  (_, index) => `<tag${index}>payload ${index}</tag${index}>`,
).join(' ') + filler

console.table([
  measure('50 absent tags', 50, filler, false),
  measure('50 absent tags (streaming)', 50, filler, true),
  measure('50 absent tags (other markup)', 50, markupFiller, true),
  measure('100 matches, one tag', 1, oneTag, false),
  measure('20 matching tags', 20, manyTags, false),
])
