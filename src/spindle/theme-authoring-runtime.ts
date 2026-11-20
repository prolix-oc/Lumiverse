import {
  decodeThemePackArchive,
  encodeThemePackArchive,
  type ThemePack,
} from '../utils/theme-pack';
import { THEME_AUTHORING_ACCESS } from '../services/theme-authoring-requests';
import type {
  ThemeAuthoringAPI,
  ThemeAuthoringRequest,
  ThemeAuthoringHostRequest,
} from 'lumiverse-spindle-types';

export type ThemeAuthoringWorkerMessage = Extract<
  import('lumiverse-spindle-types').WorkerToHost,
  { type: 'theme_authoring' }
>;

export function createThemeAuthoringRuntime(
  request: (message: ThemeAuthoringWorkerMessage) => Promise<unknown>,
  assertMutation: (member: string) => void,
): ThemeAuthoringAPI {
  return Object.freeze({
    version: 1 as const,
    async request(input: ThemeAuthoringRequest, userId?: string) {
      if (THEME_AUTHORING_ACCESS[input.operation] !== 'read')
        assertMutation('spindle.theme.authoring.request()');
      let wire: ThemeAuthoringHostRequest;
      if (input.operation === 'import') {
        const decoded = decodeThemePackArchive(input.args.bytes);
        if (decoded.error) throw new Error(decoded.error.message);
        wire = { operation: 'import', args: { pack: decoded.pack } };
      } else wire = input;
      const result = await request({
        type: 'theme_authoring',
        requestId: crypto.randomUUID(),
        input: wire,
        userId,
      });
      return input.operation === 'export_current' || input.operation === 'export_draft'
        ? encodeThemePackArchive(result as ThemePack)
        : result;
    },
  }) as ThemeAuthoringAPI;
}
