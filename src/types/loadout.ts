export interface LoadoutSnapshot {
  // Lumia
  selectedDefinition: any | null;
  selectedChimeraDefinitions: any[];
  selectedBehaviors: any[];
  selectedPersonalities: any[];
  chimeraMode: boolean;
  lumiaQuirks: string;
  lumiaQuirksEnabled: boolean;
  // Council
  councilSettings: any;
  // Loom
  selectedLoomStyles: any[];
  selectedLoomUtils: any[];
  selectedLoomRetrofits: any[];
  // OOC
  oocEnabled: boolean;
  lumiaOOCStyle: string;
  lumiaOOCInterval: number | null;
  // Sovereign Hand
  sovereignHand: {
    enabled: boolean;
    excludeLastMessage: boolean;
    includeMessageInPrompt: boolean;
  };
  // Context Filters
  contextFilters: any;
}

export interface Loadout {
  id: string;
  name: string;
  snapshot: LoadoutSnapshot;
  created_at: number;
  updated_at: number;
}

export interface LoadoutBinding {
  loadout_id: string;
  bound_at: number;
}

export interface ResolvedLoadout {
  loadout: Loadout | null;
  source: "chat" | "character" | "none";
}
