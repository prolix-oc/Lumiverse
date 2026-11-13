export interface DeletionOperation {
  operationId: string;
  entity: "character";
  entityId: string;
  status: "accepted" | "completed" | "failed" | "unknown";
  createdAt: number;
  updatedAt: number;
  error?: { code: string; message: string; outcome?: string };
}
