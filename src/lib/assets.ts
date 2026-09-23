import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssetMetadata, AssetRef, AssetStore } from "../contracts/index.js";
import { AssetMetadataSchema, AssetRefSchema, AssetUploadSchema } from "../contracts/schemas/assets.js";
import { assert, CodedError } from "./error.js";
import { parseSchema } from "./validation.js";

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_ID = /^a_[a-f0-9]{32}$/;

export function decodeUpload(raw: unknown): Uint8Array {
  const upload = parseSchema(AssetUploadSchema, raw, "asset upload");
  assert(upload.data.length <= Math.ceil(MAX_ASSET_BYTES / 3) * 4, "asset exceeds 8 MiB", "invalid");
  const bytes = Buffer.from(upload.data, "base64");
  assert(bytes.length <= MAX_ASSET_BYTES && bytes.toString("base64") === upload.data, "invalid base64 asset", "invalid");
  return bytes;
}

/** Private files under the service home, outside every userspace fence. */
export class FileAssetStore implements AssetStore {
  constructor(private readonly root: string) {}

  async put(owner: string, bytes: Uint8Array, metadata: AssetMetadata): Promise<AssetRef> {
    const asset = { ...parseSchema(AssetMetadataSchema, metadata, "asset metadata"), id: `a_${randomUUID().replaceAll("-", "")}`, size: bytes.byteLength };
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
      const asset = parseSchema(AssetRefSchema, JSON.parse(await readFile(join(dir, "metadata.json"), "utf8")), "stored asset");
      const bytes = await readFile(join(dir, "data"));
      assert(asset.id === id && asset.size === bytes.byteLength, "stored asset metadata does not match its data", "invalid");
      return { asset, bytes };
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
