import { z } from "zod";

export const AssetMetadataSchema = z.looseObject({
  mediaType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/, "invalid asset media type"),
  name: z.string().max(255).regex(/^[^\x00-\x1f\x7f]*$/, "invalid asset name").optional(),
});

export const AssetRefSchema = AssetMetadataSchema.extend({
  id: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const AssetUploadSchema = AssetMetadataSchema.extend({ data: z.string() });
export const AssetDownloadSchema = z.looseObject({ asset: AssetRefSchema, data: z.string() });
