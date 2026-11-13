import { createThemeAuthoringRuntime } from './theme-authoring-runtime';

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const api = createThemeAuthoringRuntime(
  (message) =>
    new Promise((resolve, reject) => {
      pending.set(message.requestId, { resolve, reject });
      postMessage({ kind: 'request', message });
    }),
  () => {},
);

self.onmessage = async (event: MessageEvent<any>) => {
  const message = event.data;
  if (message.type === 'response') {
    const waiter = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
    return;
  }
  if (message.kind !== 'start') return;
  try {
    const current = await api.request({ operation: 'state', args: {} }, 'worker');
    const { bundleId } = await api.request({ operation: 'asset_create_bundle', args: {} }, 'worker');
    await api.request(
      {
        operation: 'asset_upload',
        args: {
          bundleId,
          name: 'font.ttf',
          mimeType: 'font/ttf',
          bytes: new Uint8Array(1024 * 1024).fill(7),
        },
      },
      'worker',
    );
    await api.request(
      {
        operation: 'install',
        args: {
          draft: { name: 'Worker theme', globalCSS: 'body{color:red}', assetBundleId: bundleId },
          options: { expectedRevision: current.revision },
        },
      },
      'worker',
    );
    const archive = await api.request({ operation: 'export_current', args: {} }, 'worker');
    const imported = await api.request({ operation: 'import', args: { bytes: archive } }, 'worker');
    postMessage({
      kind: 'done',
      archiveIsBytes: archive instanceof Uint8Array,
      archiveSize: archive.length,
      importedAssets: imported.assets.length,
      noBrowser: typeof document === 'undefined' && typeof window === 'undefined',
    });
  } catch (error) {
    postMessage({ kind: 'failed', error: (error as Error).message });
  }
};
