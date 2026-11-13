import type { CouncilSettings } from "lumiverse-spindle-types";
import type { SidecarSettings } from "../services/sidecar-settings.service";

export type CouncilProfileSource = "chat" | "character" | "defaults" | "none";

export interface CouncilProfileBinding {
  council_settings: CouncilSettings;
  sidecar_settings: SidecarSettings;
  captured_at: number;
}

export interface ResolvedCouncilProfile {
  binding: CouncilProfileBinding | null;
  source: CouncilProfileSource;
  council_settings: CouncilSettings;
  sidecar_settings: CouncilProfileBinding["sidecar_settings"];
}
