/** Mirrors lumiverse-spindle-types until the UUID contract is published. */
export interface SpindleUUIDAPI {
  v4(): Promise<string>;
  v7(): Promise<string>;
}

export type UUIDWorkerMessage = {
  type: "uuid_generate";
  requestId: string;
  version: 4 | 7;
};
