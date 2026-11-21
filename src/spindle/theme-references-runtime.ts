import { uuidv4 } from "../utils/uuid";
import type { ThemeReferencesAPI, ThemeReferencesRequest, WorkerToHost } from 'lumiverse-spindle-types';

export type ThemeReferencesWorkerMessage = Extract<WorkerToHost, { type: 'theme_references' }>;

export function createThemeReferencesRuntime(
  request: (message: ThemeReferencesWorkerMessage) => Promise<unknown>,
): ThemeReferencesAPI {
  return Object.freeze({
    version: 1 as const,
    request(input: ThemeReferencesRequest) {
      return request({ type: 'theme_references', requestId: uuidv4(), input });
    },
  }) as ThemeReferencesAPI;
}
