import { randomUUID } from "node:crypto";
import type { AssetDownload, AssetRef, AssetStore, AssetUpload, Message } from "../contracts/index.js";
import { decodeUpload } from "../lib/assets.js";
import { isAssetPart } from "../lib/content.js";
import { assert } from "../lib/error.js";

interface Grant {
  owner: string;
  provider: string;
  ids: Set<string>;
}

/** Owner access and temporary, explicitly scoped provider access to binary data. */
export class AssetAccess {
  private readonly grants = new Map<string, Grant>();
  private readonly writes = new Map<string, Set<Promise<AssetRef>>>();

  constructor(private readonly store: AssetStore) {}

  async put(actor: string, upload: AssetUpload, token?: string): Promise<AssetRef> {
    const grant = token === undefined ? undefined : this.grant(actor, token);
    const bytes = decodeUpload(upload);
    const owner = grant?.owner ?? actor;
    const pending = this.store.put(owner, bytes, { mediaType: upload.mediaType, ...(upload.name === undefined ? {} : { name: upload.name }) });
    const writes = this.writes.get(owner) ?? new Set<Promise<AssetRef>>();
    this.writes.set(owner, writes);
    writes.add(pending);
    try {
      const asset = await pending;
      grant?.ids.add(asset.id);
      return asset;
    } finally {
      writes.delete(pending);
      if (!writes.size) this.writes.delete(owner);
    }
  }

  async read(actor: string, id: string, token?: string): Promise<AssetDownload> {
    const grant = token === undefined ? undefined : this.grant(actor, token);
    assert(!grant || grant.ids.has(id), "asset is not granted to this provider call", "unauthorized");
    const { asset, bytes } = await this.store.read(grant?.owner ?? actor, id);
    return { asset, data: Buffer.from(bytes).toString("base64") };
  }

  async during<T>(owner: string, provider: string, messages: Message[], run: (token: string) => Promise<T>): Promise<T> {
    const ids = new Set(messages.flatMap((message) => message.content.filter(isAssetPart).map((part) => part.data.id)));
    for (const id of ids) await this.store.read(owner, id);
    const token = randomUUID();
    this.grants.set(token, { owner, provider, ids });
    try {
      return await run(token);
    } finally {
      this.grants.delete(token);
    }
  }

  async forget(owner: string): Promise<void> {
    for (const [token, grant] of this.grants) if (grant.owner === owner || grant.provider === owner) this.grants.delete(token);
    await Promise.allSettled(this.writes.get(owner) ?? []);
    await this.store.removeOwner(owner);
  }

  private grant(actor: string, token: string): Grant {
    const grant = this.grants.get(token);
    assert(grant && grant.provider === actor, "asset grant is invalid or expired", "unauthorized");
    return grant;
  }
}
