/** Binary storage is separate from conversation JSON and from the document store. */
export interface AssetMetadata {
  mediaType: string;
  name?: string;
}

export interface AssetRef extends AssetMetadata {
  id: string;
  size: number;
}

/** Base64 is a transport encoding only; messages keep an asset reference. */
export interface AssetUpload extends AssetMetadata {
  data: string;
}

export interface AssetDownload {
  asset: AssetRef;
  data: string;
}

export interface AssetClient {
  put(upload: AssetUpload): Promise<AssetRef>;
  read(id: string): Promise<AssetDownload>;
}

/** A host may inject any binary store. Ownership is supplied by the kernel. */
export interface AssetStore {
  put(owner: string, bytes: Uint8Array, metadata: AssetMetadata): Promise<AssetRef>;
  read(owner: string, id: string): Promise<{ asset: AssetRef; bytes: Uint8Array }>;
  removeOwner(owner: string): Promise<void>;
}

/** Valid only for this provider invocation and its referenced/generated assets. */
export interface ProviderContext {
  assets: AssetClient;
}
