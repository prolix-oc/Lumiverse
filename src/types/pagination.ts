export interface PaginationParams {
  limit: number;
  offset: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;
export const RECENT_CHATS_DEFAULT_LIMIT = 20;
