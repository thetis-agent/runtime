# Validation at data boundaries

The runtime uses Zod to turn `unknown` input into trusted data. Serializable contract types are
inferred from the schemas in `src/contracts/schemas`; services and executable adapters retain their
interfaces and constructor-injected dependencies. Zod is the runtime's only external dependency.

```ts
import { StepPlanSchema } from "@thetis/runtime/schemas";
import { parseSchema } from "@thetis/runtime/lib/validation";

const plan = parseSchema(StepPlanSchema, raw, "enumerator result", "enumerator");
for (const step of plan) {
  // step is inferred from successful parsing. Check its declared package export next.
}
```

`parseSchema` wraps validation failures in a `CodedError` with the boundary context and field path.
It reports validation issues without serializing the rejected payload. Use `safeParse` when an
invalid cache is intentionally ignored or a boundary has its own error response format.

## Ownership

- Shared runtime schemas cover content, messages, steps, events, model listings, assets, packages,
  configuration, identities, sessions, and benchmark data.
- The kernel validates enumerator plans, step mutations, provider output, and RPC arguments before
  dispatching or mutating state. A failed step result is rejected as a whole. Authorization still
  checks users, installed package exports, asset grants, and ownership after shape validation.
- Kernel clients validate known replies and streamed events before giving them to typed callers.
  Dynamic operator extensions return `unknown`; their callers validate results with the extension's
  schema. A generic type argument cannot validate a response.
- Persistence readers validate records before use. Partial kernel configuration is checked before
  merging defaults, and the completed configuration is checked after environment interpolation.
- OpenRouter, Exa, marketplace, benchmark, gateway, harness, and prompt-cache schemas live with those
  extensions. Packages that import Zod declare it as a runtime dependency.

## Compatibility and extensibility

Content kinds remain open: a content part has a nonempty `type`, optional ID, and JSON `data`.
An unfamiliar namespaced image, audio, or application part survives normalization. The envelope does
not require the kernel to understand the modality. Extensions validate the data kinds they interpret.
Extensible envelopes preserve extra fields with `looseObject`; closed configuration declarations
reject misspelled keys. Choose this behavior deliberately because ordinary `z.object` strips extras.
The reserved `__proto__` key is explicitly rejected in content/message envelopes instead of silently
discarded. Opaque content `data` retains it safely as an ordinary own JSON property.

Legacy text input and stored text messages normalize to text parts. Missing tool parameter schemas
and omitted provider tools/params retain their supported defaults. Wrong types do not become defaults:
arrays cannot masquerade as records, and the string `"false"` cannot enable a boolean option.

JSON validation retains the existing limits on nesting, size, dense arrays, cycles, and finite
numbers. Binary data still belongs in the asset store. Stateful rules, such as ordered content stream
lifecycles, remain explicit code alongside shape validation.

New boundaries should accept `unknown`, parse once where data enters the owning component, and pass
the inferred result onward. Avoid `as SomeDto`, callback parameter annotations over an unvalidated
array, or unchecked `z.custom<T>()`. Add regression tests for malformed inputs and valid legacy or
extension data that the boundary must preserve.
