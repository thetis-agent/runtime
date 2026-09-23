import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetMetadata, AssetRef, AssetStore, AssetUpload } from "../contracts/index.js";
import { assert, CodedError } from "./error.js";

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_ID = /^a_[a-f0-9]{32}$/;

export function decodeUpload(upload: AssetUpload): Uint8Array {
  assert(upload && typeof upload.data === "string", "asset data must be base64", "invalid");
  assert(upload.data.length <= Math.ceil(MAX_ASSET_BYTES / 3) * 4, "asset exceeds 8 MiB", "invalid");
  const bytes = Buffer.from(upload.data, "base64");
  assert(bytes.length <= MAX_ASSET_BYTES && bytes.toString("base64") === upload.data, "invalid base64 asset", "invalid");
  assert(typeof upload.mediaType === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(upload.mediaType), "invalid asset media type", "invalid");
  assert(upload.name === undefined || (typeof upload.name === "string" && upload.name.length <= 255 && !/[\x00-\x1f\x7f]/.test(upload.name)), "invalid asset name", "invalid");
  return bytes;
}

/** Private files under the service home, outside every userspace fence. */
export class FileAssetStore implements AssetStore {
  constructor(private readonly root: string) {}

  async put(owner: string, bytes: Uint8Array, metadata: AssetMetadata): Promise<AssetRef> {
    const asset = { ...metadata, id: `a_${randomUUID().replaceAll("-", "")}`, size: bytes.byteLength };
    const dir = this.path(owner, asset.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(dir, "data"), bytes, { mode: 0o600 });
      await writeFile(join(dir, "metadata.json"), JSON.stringify(asset), { mode: 0o600 });
      return asset;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async read(owner: string, id: string): Promise<{ asset: AssetRef; bytes: Uint8Array }> {
    const dir = this.path(owner, id);
    try {
      const asset = JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")) as AssetRef;
      return { asset, bytes: await readFile(join(dir, "data")) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodedError(`unknown asset ${id}`, "not-found");
      throw error;
    }
  }

  removeOwner(owner: string): Promise<void> {
    return rm(this.ownerPath(owner), { recursive: true, force: true });
  }

  private ownerPath(owner: string): string {
    return join(this.root, Buffer.from(owner).toString("base64url"));
  }

  private path(owner: string, id: string): string {
    assert(ASSET_ID.test(id), "invalid asset id", "invalid");
    return join(this.ownerPath(owner), id);
  }
}
