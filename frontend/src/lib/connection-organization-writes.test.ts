import { expect, test } from 'bun:test'
import { createOrganizationWriter } from './connection-organization-writes'
import { applyOrganizationEdits, type OrganizationEdit } from '../../../src/shared/connection-organization-edits'

test('rapid edits serialize, keep optimistic work and never overwrite another kind', async () => {
  const pending: Array<() => void> = []; let server = {}; let shown: any
  const writer = createOrganizationWriter({
    write: edits => new Promise(resolve => pending.push(() => { server = applyOrganizationEdits(server, edits); resolve(server) })),
    commit: values => { shown = values }, failed: () => { throw new Error('unexpected') },
  })
  const create = (kind: 'llm' | 'tts', id: string): OrganizationEdit => ({ kind, action: 'create', id, name: id })
  writer.enqueue([create('llm', 'a')]); writer.enqueue([create('tts', 'b')])
  expect(pending).toHaveLength(1)
  pending.shift()!(); await Bun.sleep(0)
  expect(shown.connectionLibraries.tts.folders[0].id).toBe('b')
  pending.shift()!(); await Bun.sleep(0)
  expect(server).toEqual(shown); writer.dispose()
})
test('disposed session cannot commit a late response or send queued work', async () => {
  let finish!: (value: {}) => void; let calls = 0; let commits = 0
  const writer = createOrganizationWriter({ write: () => { calls++; return new Promise(resolve => { finish = resolve }) },
    commit: () => { commits++ }, failed: () => {} })
  const edit: OrganizationEdit = { kind: 'llm', action: 'remember', id: 'a' }
  writer.enqueue([edit]); writer.enqueue([edit]); writer.dispose(); finish({}); await Bun.sleep(0)
  expect(calls).toBe(1); expect(commits).toBe(0)
})

test('new edits during failure recovery resume without requiring another interaction', async () => {
  let finish!: (value: {}) => void; let calls = 0; let shown: any
  const writer = createOrganizationWriter({ write: async edits => {
    if (++calls === 1) throw new Error('offline')
    return applyOrganizationEdits({}, edits)
  }, commit: value => { shown = value }, failed: () => new Promise(resolve => { finish = resolve }) })
  writer.enqueue([{ kind: 'llm', action: 'remember', id: 'failed' }]); await Bun.sleep(0)
  writer.enqueue([{ kind: 'tts', action: 'remember', id: 'new' }]); finish({}); await Bun.sleep(0)
  expect(calls).toBe(2); expect(writer.pending).toBe(false)
  expect(shown.recentConnections).toEqual({ tts: ['new'] }); writer.dispose()
})
