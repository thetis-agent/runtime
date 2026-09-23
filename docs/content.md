# Structured content (runtime 0.2)

The runtime carries ordered JSON content parts. It validates the envelope and JSON portability; packages own the meaning of each content kind. Adding a modality does not require a kernel change.

```ts
import { textPart, assetPart } from "@thetis/runtime";
import type { ContentPart, Message, TurnInput } from "@thetis/runtime/contracts";

const photo = await env.kernel.assets.put({
  mediaType: "image/png",
  name: "diagram.png",
  data: bytes.toString("base64"),
});
const input: TurnInput = {
  role: "user",
  content: [textPart("Explain this diagram"), assetPart(photo.id, photo.mediaType, photo.name)],
};
const reply: Message = await env.kernel.sessions.complete(sessionId, input);
```

`ContentPart` is `{ id?: string; type: string; data: JsonValue }`. `JsonValue` includes null, finite numbers, booleans, strings, arrays and plain objects. The shared helpers define `text` (`{ text }`) and `asset` (`{ id, mediaType, name? }`). Packages can use a namespaced, versioned type such as `@example/mesh.v1`. Unknown kinds and their payloads survive RPC, steps, transcripts, saving and loading. A message may also have an `id` and namespaced `extensions: Record<string, JsonValue>`.

Messages use `content: ContentPart[]` internally and in results. `send`, `complete`, `askText` and the deprecated `ask` accept the same `TurnInput`: text, one message, or an array of messages. Input messages may still carry string content. The API normalizes that shorthand immediately. Old session files normalize on read and are written in canonical form on the next save. Step results with legacy strings also normalize at the boundary.

`complete` returns the final assistant message, including parts and tool calls. `askText` and its compatibility alias `ask` return only recognized text parts. `contentText` is the same deliberately lossy projection for search and previews. Transform a message by copying its existing parts and adding your own; do not reconstruct its content from that projection.

## Assets and injection

`env.kernel.assets.put(upload)` and `.read(id)` act as the authenticated fence owner. The RPC representation uses base64; conversation parts contain only opaque asset IDs and metadata. IDs are not filesystem paths or credentials. Assets belong to a user, may be referenced by multiple sessions, and are removed when that user is deleted. Session deletion does not garbage-collect assets.

The host binds `T.assetStore` to the `AssetStore` interface. Its default `FileAssetStore` keeps binary files and metadata under the private service home, outside userspace fences. This is independent of the document store and its TOML rules. Embedders can inject another store before `createKernel` resolves services:

```ts
const kernel = await createKernel(config, container => {
  container.bind(T.assetStore, () => myBinaryStore);
});
```

The kernel routes a provider call with a temporary grant for the standard asset references in that call's messages. A provider receives an optional third argument to `call(call, signal, context)`; `context.assets.read(id)` can read those references, and `context.assets.put(upload)` creates output assets for the caller. Contexts are scoped to an invocation, even when a provider instance is cached. They expire on completion or failure. The unit of trust remains the userspace fence, as for other kernel methods.

Portable envelopes are limited to 16 MiB per message, 4,096 parts, and 64 levels of JSON nesting. The default upload boundary accepts at most 8 MiB per asset. Functions, undefined payloads, nonfinite numbers, class instances, cycles and sparse arrays are rejected instead of being silently changed by JSON serialization.

## Tools and streams

Tools can return `{ type: "tool-result", content: ContentPart[] }`. Legacy strings and arbitrary objects retain their previous text / JSON-text behavior. The explicit result marker disambiguates rich output from an ordinary object. `tool.result` events carry canonical `content` and the legacy `result` text projection.

Providers may keep emitting `{ type: "text", delta }`. Structured streaming uses:

- `content.start`: `messageId` and a part with a nonempty `id`.
- `content.delta`: `messageId`, `partId`, and arbitrary JSON `delta`.
- `content.end`: `messageId` and the complete final part with the same ID and type.

One provider response uses one message ID. Part IDs are unique within the response. Text deltas for a text part are strings. Packages may interpret other deltas; consumers that do not understand them retain the final snapshot from `content.end`. Missing end events fail explicitly, preserving partial snapshots when a turn stops. The harness retains the relative order of legacy text and structured parts.

`{ type: "extension", name: "@example/progress", data }` carries transient package events. They are forwarded and replayed to watchers during a running turn. Durable output belongs in message parts or extensions, since event history is not the session record. Watch events and running-turn records include complete input `messages` alongside the legacy `input` text preview.

## Shipped adapters

OpenRouter translates user text, image assets (PNG/JPEG/WebP/GIF), supported audio assets and PDFs. It verifies asset metadata and fails explicitly for unsupported part types, media types or non-text roles. Model support still determines whether a request is accepted. Generated image/audio streams are not decoded by this adapter yet; they produce an explicit error. Other providers can already emit the generic structured events and store generated assets through their call context.

Protocol references: [image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding), [audio](https://openrouter.ai/docs/guides/overview/multimodal/audio), [PDF inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs).

The web gateway accepts `{ input: TurnInput }` at `POST /api/sessions/:id/send`; `{ text }` remains supported. `POST /api/media?name=...` accepts raw bytes with a media type; `GET /api/media/:id` reads an owned asset. These endpoints require the person's authenticated cookie, and writes use the gateway's same-site checks. The transcript renders image/audio/video attachments and download links; unknown parts remain inspectable. The composer attaches pictures too: a paste, a drop or the paper-clip uploads through `POST /api/media` and the message goes out as `{ input }` with an `asset` part beside the text. API clients can send attachments the same way.

Extension authors upgrading from 0.1 must update string reads to `contentText` where a text projection is intended, construct new text with `textPart`/`textContent`, and preserve unfamiliar parts when editing messages. Declare the `@thetis/runtime` 0.2 peer dependency. The host links the runtime into each userspace's module search path, so copied packages can import its SDK helpers as shipped packages do. Rebuild and restart the runtime to load this contract revision.
