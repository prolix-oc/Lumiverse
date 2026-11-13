import type { DecisionConnectionProfileDTO } from "../decision/contract";
export type DecisionConnectionProfile = DecisionConnectionProfileDTO;
export interface CreateDecisionConnectionInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  default_parameters?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  api_key?: string;
}
export type UpdateDecisionConnectionInput = Partial<CreateDecisionConnectionInput>;
