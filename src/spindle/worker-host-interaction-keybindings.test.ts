import { expect, test } from 'bun:test';
import { WorkerHostInteractionApi } from './worker-host-interaction-api';
import type { SpindleManifest } from 'lumiverse-spindle-types';

test('registered Spindle commands receive key binding metadata and retain the invoking user context', () => {
  const messages: unknown[] = [];
  let active = true;
  const api = new WorkerHostInteractionApi({
    extensionId: 'installed', manifest: { name: 'Capture', identifier: 'capture' } as SpindleManifest,
    installScope: 'user', installedByUserId: 'alice', isRuntimeActive: () => active,
    resolveEffectiveUserId: () => 'alice', enforceScopedUser: () => {}, post: message => messages.push(message),
  });
  api.handleCommandsRegister([{ id: 'analyze', label: 'Analyze Screen', description: '', scope: 'chat' }]);
  const context = { route: '/chat/current', chatId: 'current', trigger: { type: 'keybind' as const, bindingId: 'configured', scope: 'global' as const } };
  api.invokeCommand('analyze', context, 'alice');
  expect(messages).toEqual([{ type: 'command_invoked', commandId: 'analyze', context, userId: 'alice' }]);
  messages.length = 0;
  api.invokeCommand('analyze', context, 'alice', 'desktop-document');
  expect(messages).toEqual([{ type: 'command_invoked', commandId: 'analyze', context, userId: 'alice', frontendSessionId: 'desktop-document' }]);
  messages.length = 0;
  api.handleCommandsUnregister(['analyze']);
  api.invokeCommand('analyze', context, 'alice');
  expect(messages).toEqual([]);
  api.handleCommandsRegister([{ id: 'analyze', label: 'Analyze Screen', description: '' }]);
  active = false;
  api.invokeCommand('analyze', context, 'alice');
  expect(messages).toEqual([]);
});
