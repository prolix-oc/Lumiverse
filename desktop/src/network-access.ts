export interface BundledNetworkAccess {
  configured: boolean;
  enabled: boolean;
  host: string;
  overridden: boolean;
}

/** Persist before interrupting service; a stopped server must stay stopped. */
export async function changeNetworkAccess(options: {
  enabled: boolean;
  running: boolean;
  save: (enabled: boolean) => Promise<BundledNetworkAccess>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}): Promise<BundledNetworkAccess> {
  const saved = await options.save(options.enabled);
  if (options.running) {
    await options.stop();
    await options.start();
  }
  return saved;
}
