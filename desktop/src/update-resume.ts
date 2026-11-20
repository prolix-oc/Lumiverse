export interface DesktopUpdateResume {
  resumeServer: boolean;
  reopenFrontend: boolean;
  localPort?: number;
}

interface StartupOptions {
  remote: boolean;
  canStartServer: boolean;
  autoStartServer: boolean;
  connectionChosen?: boolean;
}

interface StartupActions {
  startServer(reopenFrontend: boolean): Promise<void>;
  detectExternalServer(): Promise<void>;
  showFrontend(): Promise<void>;
  chooseConnection?(): Promise<void>;
}

/** A consumed update launch overrides normal startup choices for this boot only. */
export async function restoreDesktopSession(
  resume: DesktopUpdateResume | null,
  options: StartupOptions,
  actions: StartupActions,
): Promise<void> {
  if (options.connectionChosen === false) {
    await actions.chooseConnection?.();
    return;
  }
  if (!options.remote && options.canStartServer && (resume ? resume.resumeServer : options.autoStartServer)) {
    // startServer opens the browser after the server reports readiness.
    await actions.startServer(resume ? resume.reopenFrontend : true);
    return;
  }
  if (!options.remote) await actions.detectExternalServer();
  // A visible browser can belong to a remote, external, or stopped server.
  if (resume?.reopenFrontend) await actions.showFrontend();
}
