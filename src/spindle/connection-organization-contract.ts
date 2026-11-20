import type { SpindleBackendConnectionOrganizationOptions, SpindleConnectionOrganizationAPI } from 'lumiverse-spindle-types';
import type { ConnectionOrganizationSnapshot } from '../shared/connection-organization';
export type BackendOrganizationOptions = SpindleBackendConnectionOrganizationOptions;
export type BackendOrganizationAPI = SpindleConnectionOrganizationAPI<BackendOrganizationOptions>;
export type OrganizationWorkerMessage =
  | { type: 'connection_organization_get'; requestId: string; options: BackendOrganizationOptions }
  | { type: 'connection_organization_watch'; requestId: string; subscriptionId: string; options: BackendOrganizationOptions }
  | { type: 'connection_organization_unwatch'; subscriptionId: string };
export type OrganizationHostMessage = { type: 'connection_organization_snapshot'; subscriptionId: string;
  snapshot?: ConnectionOrganizationSnapshot; error?: string };
