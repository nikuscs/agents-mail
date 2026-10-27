import * as Utils from "./worker.utils";
import type * as Types from "./worker.types";

export function makeStorage(bucket: R2Bucket) {
  return {
    async put(params: Types.WorkerPutParams): Promise<void> {
      const disposition = params.filename
        ? `attachment; filename*=UTF-8''${encodeURIComponent(params.filename).replaceAll(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
        : "attachment";

      await bucket.put(Utils.workerKey(params.emailId, params.id), params.content, {
        httpMetadata: {
          contentType: params.mimeType ?? undefined,
          contentDisposition: disposition,
        },
      });
    },

    get(params: Types.WorkerDownloadParams): Promise<R2ObjectBody | null> {
      return bucket.get(Utils.workerKey(params.id, params.attachment));
    },

    async delete(keys: string[]): Promise<void> {
      const chunks = Array.from({ length: Math.ceil(keys.length / 1_000) }, (_, index) => keys.slice(index * 1_000, (index + 1) * 1_000));

      await Promise.all(chunks.map(async (chunk) => bucket.delete(chunk)));
    },
  };
}
