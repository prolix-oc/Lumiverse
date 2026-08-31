/**
 * Database-only authority used by the unauthenticated image-generation result
 * endpoint. It is deliberately not derived from a caller-controlled filename.
 */
export const SERVER_IMAGE_GENERATION_PROVENANCE = "server_image_generation_v1" as const;
