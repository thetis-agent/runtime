import type { ContentEvent, ContentPart, Message } from "../contracts/index.js";
import { assert } from "./error.js";
import { assertJson, isTextPart, normalizeContent, textPart } from "./content.js";

/** One assistant response. Opaque deltas are relayed; end carries the authoritative final part. */
export class ContentStream {
  private parts: ContentPart[] = [];
  private readonly open = new Set<string>();
  private messageId?: string;
  private textIndex?: number;

  text(delta: string): void {
    if (this.textIndex === undefined) {
      this.textIndex = this.parts.length;
      this.parts.push(textPart(""));
    }
    const part = this.parts[this.textIndex];
    if (isTextPart(part)) part.data.text += delta;
  }

  accept(event: ContentEvent): void {
    assert(typeof event.messageId === "string" && !!event.messageId, "content event needs a message ID", "provider");
    assert(this.messageId === undefined || this.messageId === event.messageId, "one response must use one message ID", "provider");
    this.messageId = event.messageId;
    this.textIndex = undefined;
    if (event.type === "content.delta") {
      assert(this.open.has(event.partId), "delta names an unopened part", "provider");
      assertJson(event.delta);
      const part = this.parts.find((p) => p.id === event.partId)!;
      if (isTextPart(part) && typeof event.delta === "string") part.data.text += event.delta;
      return;
    }
    const part = normalizeContent([event.part])[0];
    assert(typeof part.id === "string" && !!part.id, "streamed content needs a part ID", "provider");
    const index = this.parts.findIndex((p) => p.id === part.id);
    if (event.type === "content.start") {
      assert(index < 0, "content part has already started", "provider");
      this.parts.push(part);
      this.open.add(part.id);
    } else {
      assert(this.open.has(part.id) && index >= 0 && this.parts[index].type === part.type, "end names an unopened or different part", "provider");
      this.parts[index] = part;
      this.open.delete(part.id);
    }
  }

  finish(): void {
    assert(this.open.size === 0, "provider ended with unfinished content parts", "provider");
  }

  message(): Message {
    return { role: "assistant", ...(this.messageId ? { id: this.messageId } : {}), content: normalizeContent(this.parts) };
  }
}
