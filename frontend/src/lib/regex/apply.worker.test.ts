import { expect, test } from 'bun:test'
import type { ApplyWorkerResponse, ApplyWorkerScript } from './apply.worker'

async function apply(body: string, scripts: ApplyWorkerScript[]): Promise<ApplyWorkerResponse[]> {
  const worker = new Worker(new URL('./apply.worker.ts', import.meta.url), { type: 'module' })
  try {
    return await new Promise((resolve, reject) => {
      const messages: ApplyWorkerResponse[] = []
      const timer = setTimeout(() => reject(new Error('worker did not finish')), 3000)
      worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)) }
      worker.onmessage = ({ data }: MessageEvent<ApplyWorkerResponse>) => {
        messages.push(data)
        if (data.type === 'result' || data.type === 'error') {
          clearTimeout(timer)
          if (data.type === 'error') reject(new Error(data.error))
          else resolve(messages)
        }
      }
      worker.postMessage({ jobId: 1, op: 'apply', body, scripts })
    })
  } finally {
    worker.terminate()
  }
}

test('worker skips unmatched scripts without progress traffic and checkpoints before actual work', async () => {
  const messages = await apply('x', [
    { scriptId: 'absent', pattern: '(a+)+ENDING', flags: 'g', replaceString: 'bad', trimStrings: [] },
    { scriptId: 'introduce', pattern: 'x', flags: 'g', replaceString: 'valueENDING', trimStrings: [] },
    { scriptId: 'consume', pattern: 'valueENDING', flags: 'g', replaceString: 'done', trimStrings: [] },
  ])
  expect(messages.filter((m) => m.type === 'progress').map((m) => m.scriptId)).toEqual(['introduce', 'consume'])
  expect(messages.filter((m) => m.type === 'checkpoint').map((m) => [m.scriptIndex, m.result]))
    .toEqual([[0, 'x'], [1, 'valueENDING']])
  expect(messages.at(-1)).toMatchObject({ type: 'result', result: 'done' })
})

test('worker preserves trimming without a match and emits nothing per skipped script', async () => {
  const messages = await apply('text', [
    { pattern: 'ABSENT', flags: 'g', replaceString: 'bad', trimStrings: ['', 'text'] },
    { pattern: 'ALSOABSENT', flags: 'g', replaceString: 'bad', trimStrings: [] },
  ])
  expect(messages.filter((m) => m.type === 'progress')).toHaveLength(1)
  expect(messages.filter((m) => m.type === 'checkpoint')).toHaveLength(0)
  expect(messages.at(-1)).toMatchObject({ type: 'result', result: '' })
})
