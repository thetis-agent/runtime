import { contentText } from "@thetis/runtime/lib/content";
// Deterministic provider for tests. "run: <cmd>" asks for the shell tool; a tool result is echoed back.
export function createProvider(config) {
  return {
    async models() { return [{ id: "echo" }]; },
    async *call(call, signal, context) {
      const last = call.messages[call.messages.length - 1];
      if (last?.role === "tool" && /FAIL_NEXT/.test(contentText(last.content))) { yield { type: "error", message: "the provider gave up" }; return; }
      if (last?.role === "tool") { yield { type: "text", delta: `tool said: ${contentText(last.content)}` }; return; }
      // The harness ends each input with a [Turn context: ...] line; the triggers below are the words before it.
      const text = contentText(last?.content).replace(/\n\n\[Turn context: [^\n\]]*\]$/, "");
      if (text === "bad-stream?") {
        yield { type: "content.delta", messageId: "bad", partId: "unopened", delta: "bad" };
        return;
      }
      if (text === "rich?") {
        for (const [index, part] of last.content.filter((p) => p.type !== "text").entries()) {
          if (part.type === "asset") {
            const { asset, data } = await context.assets.read(part.data.id);
            yield { type: "extension", name: "@test/asset-read", data: { id: asset.id, size: asset.size } };
            const generated = await context.assets.put({ mediaType: asset.mediaType, data });
            yield { type: "extension", name: "@test/asset-created", data: generated };
          }
          const value = { ...part, id: part.id ?? `part-${index}` };
          yield { type: "content.start", messageId: "rich-response", part: { ...value, data: null } };
          await new Promise((done) => setTimeout(done, 30));
          yield { type: "content.delta", messageId: "rich-response", partId: value.id, delta: { opaque: null } };
          yield { type: "content.end", messageId: "rich-response", part: value };
        }
        return;
      }
      if (text.startsWith("run: ") && call.tools.some((t) => t.name === "shell")) {
        yield { type: "tool_call", call: { id: "c1", name: "shell", args: { cmd: text.slice(5) } } };
        return;
      }
      if (text.startsWith("spawn: ") && call.tools.some((t) => t.name === "spawn_subagent")) {
        yield { type: "tool_call", call: { id: "c9", name: "spawn_subagent", args: { task: text.slice(7), label: "helper" } } };
        return;
      }
      if (text === "interrupt!") {
        yield { type: "tool_call", call: { id: "c5", name: "shell_interrupt", args: {} } };
        return;
      }
      if (text.startsWith("install: ")) {
        yield { type: "tool_call", call: { id: "c2", name: "install_package", args: { source: text.slice(9) } } };
        return;
      }
      if (text.startsWith("fork: ")) {
        const [name, as] = text.slice(6).split(" as ");
        yield { type: "tool_call", call: { id: "c3", name: "fork_package", args: as ? { name, as } : { name } } };
        return;
      }
      if (text.startsWith("delete: ")) {
        yield { type: "tool_call", call: { id: "c4", name: "delete_package", args: { name: text.slice(8) } } };
        return;
      }
      if (text === "packages?") {
        yield { type: "tool_call", call: { id: "c7", name: "list_packages", args: {} } };
        return;
      }
      if (text === "config?") {
        yield { type: "tool_call", call: { id: "c6", name: "probe_config", args: {} } };
        return;
      }
      if (text.startsWith("put: ")) {
        const [key, value] = text.slice(5).split(" ");
        yield { type: "tool_call", call: { id: "c7", name: "store_put", args: { key, value } } };
        return;
      }
      if (text.startsWith("get: ")) {
        yield { type: "tool_call", call: { id: "c8", name: "store_get", args: { key: text.slice(5) } } };
        return;
      }
      if (text.startsWith("slow: ")) {
        // Streams one word every 50 ms, so a test can cancel mid-stream.
        for (const word of text.slice(6).split(" ")) { await new Promise((r) => setTimeout(r, 50)); yield { type: "text", delta: word + " " }; }
        return;
      }
      if (text === "system?") { yield { type: "text", delta: call.system ?? "" }; return; }
      if (text === "tools?") { yield { type: "text", delta: call.tools.map((t) => t.name).join(",") }; return; }
      if (text === "model?") { yield { type: "text", delta: call.model }; return; }
      if (text === "hints?") { yield { type: "text", delta: JSON.stringify(call.hints ?? null) }; return; }
      yield { type: "text", delta: `echo: ${text} (${config.tag ?? "untagged"})` };
    },
  };
}
