import type { DesktopUpdateResume } from "./update-resume";

export type DesktopUpdateChannel = "stable" | "nightly";
export interface DesktopUpdateInfo {
  enabled: boolean;
  reason: string | null;
  version: string;
  defaultChannel: DesktopUpdateChannel;
}
export interface DesktopReleaseUpdate {
  version: string;
  notes: string | null;
  channel: DesktopUpdateChannel;
}
export type UpdateResume = DesktopUpdateResume;

/** Keep a failed download from interrupting the running instance. Capture the
 * state at installation time, since a large download can take several minutes. */
export async function installDesktopRelease(deps: {
  download(): Promise<void>;
  captureResume(): Promise<UpdateResume>;
  stop(): Promise<void>;
  install(resume: UpdateResume): Promise<void>;
  restore(resume: UpdateResume): Promise<void>;
}): Promise<void> {
  await deps.download();
  const resume = await deps.captureResume();
  try {
    await deps.stop();
    await deps.install(resume);
  } catch (error) {
    if (resume.resumeServer) {
      try { await deps.restore(resume); }
      catch (restoreError) { throw new Error(`${String(error)}\nThe local server could not restart: ${String(restoreError)}`); }
    }
    throw error;
  }
}
