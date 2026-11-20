export interface DesktopCaptureStatus {
  enabled: boolean;
  disabledByUser?: boolean;
  origin: string | null;
  capabilities: { image: boolean; video: boolean; replay: boolean };
  error: string | null;
}

/** Reconnect transport only. Never replay a capture or start interactive authorization. */
export async function restoreDesktopCaptureConnection(
  origin: string,
  wanted: () => boolean,
  native: {
    status(): Promise<DesktopCaptureStatus>;
    connect(origin: string): Promise<unknown>;
    disconnect(origin: string): Promise<unknown>;
  },
): Promise<void> {
  const status = await native.status();
  if (!wanted() || status.enabled || status.disabledByUser || !status.capabilities.image) return;
  try {
    await native.connect(origin);
  } finally {
    // Selection and Disable can change while native OAuth verification is awaiting I/O.
    if (!wanted()) await native.disconnect(origin);
  }
}
