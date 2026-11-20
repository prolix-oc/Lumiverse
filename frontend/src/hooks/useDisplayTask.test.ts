import { expect, test } from 'bun:test'
import { DisplayTaskQueue } from './useDisplayTask'

test('an active pass commits and only the newest pending revision executes', async () => {
  const queue = new DisplayTaskQueue()
  const commits: string[] = []
  const started: string[] = []
  let finish!: (value: string) => void
  const cancelActive = queue.schedule(() => new Promise<string>((resolve) => { finish = resolve }), (v) => commits.push(v))
  cancelActive()
  for (let i = 0; i < 100; i++) queue.schedule(async () => {
    started.push(String(i))
    return String(i)
  }, (v) => commits.push(v))
  finish('first')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(started).toEqual(['99'])
  expect(commits).toEqual(['first', '99'])
  queue.dispose()
})

test('unmount discards pending work and prevents the active completion from committing', async () => {
  const queue = new DisplayTaskQueue()
  let finish!: (value: string) => void
  const commits: string[] = []
  queue.schedule(() => new Promise<string>((resolve) => { finish = resolve }), (v) => commits.push(v))
  queue.schedule(async () => 'queued', (v) => commits.push(v))
  queue.dispose()
  finish('old')
  for (let i = 0; i < 8; i++) await Promise.resolve()
  expect(commits).toEqual([])
})
