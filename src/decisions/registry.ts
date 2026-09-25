import type { DecisionRequest, DecisionResult } from "./types";

export interface DecisionConnectionTarget {
  provider: string;
  protocol: string;
  api_url: string;
  model: string;
  account_id: string;
  apiKey: string;
}

export interface DecisionModelTarget {
  protocol: string;
  api_url: string;
  account_id: string;
  apiKey: string;
}

export interface DecisionModelList {
  models: string[];
  model_labels: Record<string, string>;
}

export interface DecisionProvider {
  id: string;
  displayName: string;
  protocols: readonly string[];
  presets: ReadonlyArray<{ id: string; name: string; url: string; model: string; protocol: string }>;
  evaluate(target: DecisionConnectionTarget, request: DecisionRequest): Promise<DecisionResult>;
  listModels(target: DecisionModelTarget): Promise<DecisionModelList>;
}

const providers = new Map<string, DecisionProvider>();

export function registerDecisionProvider(provider: DecisionProvider): void {
  if (providers.has(provider.id)) throw new Error(`Duplicate decision provider: ${provider.id}`);
  providers.set(provider.id, provider);
}

export function getDecisionProvider(id: string): DecisionProvider | undefined {
  return providers.get(id);
}

export function listDecisionProviders(): DecisionProvider[] {
  return [...providers.values()];
}
