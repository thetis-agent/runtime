import type { z } from "zod";
import type { AssetMetadataSchema, AssetRefSchema, AssetUploadSchema, AssetDownloadSchema } from "./schemas/assets.js";
/** Binary storage is separate from conversation JSON and from the document store. */
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;

export type AssetRef = z.infer<typeof AssetRefSchema>;

/** Base64 is a transport encoding only; messages keep an asset reference. */
export type AssetUpload = z.infer<typeof AssetUploadSchema>;

export type AssetDownload = z.infer<typeof AssetDownloadSchema>;

export interface AssetClient {
  put(upload: AssetUpload): Promise<AssetRef>;
  read(id: string): Promise<AssetDownload>;
}

/**
 * What a fence holds of its own user's assets. Removal is the owner's alone, so it lives here and not on
 * `AssetClient`, which is also what a provider call is lent: a provider may read and add, never erase.
 */
export interface KernelAssets extends AssetClient {
  /** `removed` is false when the owner had no such asset. */
  remove(id: string): Promise<{ id: string; removed: boolean }>;
}

/** A host may inject any binary store. Ownership is supplied by the kernel. */
export interface AssetStore {
  put(owner: string, bytes: Uint8Array, metadata: AssetMetadata): Promise<AssetRef>;
  read(owner: string, id: string): Promise<{ asset: AssetRef; bytes: Uint8Array }>;
  /** True when something was removed, false when the owner had no such asset. */
  remove(owner: string, id: string): Promise<boolean>;
  removeOwner(owner: string): Promise<void>;
}

/** Valid only for this provider invocation and its referenced/generated assets. */
export interface ProviderContext {
  assets: AssetClient;
}
