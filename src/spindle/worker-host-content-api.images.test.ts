import { describe, expect, spyOn, test } from "bun:test";
import * as imagesSvc from "../services/images.service";
import { WorkerHostContentApi } from "./worker-host-content-api";

describe("worker image upload processing", () => {
  test("routes single, bulk, and data-URL uploads through deferred processing", async () => {
    const image = {
      id: "image-1",
      filename: "image-1.png",
      original_filename: "image.png",
      mime_type: "image/png",
      byte_size: 4,
      width: null,
      height: null,
      has_thumbnail: false,
      url: "/api/v1/images/image-1",
      specificity: "full" as const,
      owner_extension_identifier: "image-pipeline-test",
      owner_character_id: null,
      owner_chat_id: null,
      created_at: 1,
    };
    const uploadDeferred = spyOn(imagesSvc, "uploadImageDeferred").mockResolvedValue(image);
    const uploadMany = spyOn(imagesSvc, "uploadImages").mockResolvedValue([{ id: image.id, image }]);
    const uploadDataUrl = spyOn(imagesSvc, "saveImageFromDataUrl").mockResolvedValue(image);

    const invoke = (
      call: (api: WorkerHostContentApi) => void,
    ): Promise<{ type: "response"; requestId: string; result?: unknown; error?: string }> => new Promise((resolve) => {
      const api = new WorkerHostContentApi({
        manifest: { identifier: "image-pipeline-test" },
        hasPermission: () => true,
        resolveEffectiveUserId: () => "owner-1",
        enforceScopedUser: () => {},
        postResponse: resolve,
      });
      call(api);
    });

    try {
      const singleResponse = await invoke((api) => api.handleImagesUpload("single", {
        data: new Uint8Array([1, 2, 3, 4]),
        filename: "single.png",
        mime_type: "image/png",
      }));
      expect(singleResponse.error).toBeUndefined();
      expect(uploadDeferred).toHaveBeenCalledTimes(1);
      expect(uploadDeferred.mock.calls[0]?.[0]).toBe("owner-1");
      expect(uploadDeferred.mock.calls[0]?.[2]).toEqual({
        owner_extension_identifier: "image-pipeline-test",
        owner_character_id: undefined,
        owner_chat_id: undefined,
      });

      const bulkResponse = await invoke((api) => api.handleImagesUploadMany("bulk", [{
        data: new Uint8Array([1, 2, 3, 4]),
        filename: "bulk.png",
        mime_type: "image/png",
      }], undefined, 3));
      expect(bulkResponse.error).toBeUndefined();
      expect(uploadMany).toHaveBeenCalledTimes(1);
      expect(uploadMany.mock.calls[0]?.[2]).toEqual({
        owner_extension_identifier: "image-pipeline-test",
        concurrency: 3,
        deferProcessing: true,
      });

      const dataUrlResponse = await invoke((api) => api.handleImagesUploadFromDataUrl(
        "data-url",
        "data:image/png;base64,AQIDBA==",
        "data-url.png",
      ));
      expect(dataUrlResponse.error).toBeUndefined();
      expect(uploadDataUrl).toHaveBeenCalledTimes(1);
      expect(uploadDataUrl.mock.calls[0]?.[0]).toBe("owner-1");
      expect(uploadDataUrl.mock.calls[0]?.[3]).toEqual({
        owner_extension_identifier: "image-pipeline-test",
        owner_character_id: undefined,
        owner_chat_id: undefined,
      });
    } finally {
      uploadDeferred.mockRestore();
      uploadMany.mockRestore();
      uploadDataUrl.mockRestore();
    }
  });
});
