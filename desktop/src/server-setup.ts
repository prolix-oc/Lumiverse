import { invoke } from "@tauri-apps/api/core";

interface SetupSettings { dataDir: string; port: number; host: string }
interface SetupInput extends SetupSettings { username: string; password: string }
interface SetupStatus { state: "setup" | "starting" | "ready" | "failed"; url?: string; error?: string }
declare global {
  interface Window {
    lumiverseSetupBridge: {
      defaults(): Promise<SetupSettings>;
      save(settings: SetupInput): Promise<unknown>;
      status(): Promise<SetupStatus>;
      complete(url: string): Promise<void>;
      pickFolder(): Promise<string | null>;
    };
  }
}

window.lumiverseSetupBridge = {
  defaults: () => invoke("bundled_setup_defaults"),
  save: (settings) => invoke("bundled_setup_save", { settings }),
  status: () => invoke("bundled_setup_status"),
  complete: () => invoke("bundled_setup_complete"),
  pickFolder: () => invoke("bundled_setup_pick_folder"),
};
