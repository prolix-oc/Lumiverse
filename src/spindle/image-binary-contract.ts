/** Host addition pending publication in lumiverse-spindle-types. */
export type ImageReadBinaryMessage = {
  type: "images_read_binary";
  requestId: string;
  imageId: string;
  userId?: string;
};

export const IMAGE_READ_MAX_BYTES = 100 * 1024 * 1024;
