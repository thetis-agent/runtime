# Thetis architecture

Thetis is a multi-user recursive language model (RLM) service with a continual harness, written in TypeScript.

This document is the top-level design: what the parts are, where the trust boundaries sit, and what "everything is a package" means in practice. It is the reference the MVP is built against.

## 1. The shape of the system

Three ideas carry the whole design.

**Recursive.** The model does its work by writing code that runs in its own session. That code can read and rewrite the harness the model is running inside — the prompt, memory, skills, tools, subagents — during the turn, not only between turns.

**Continual.** The harness persists. Each turn reads the trajectory of what has happened and writes back harness state for the next one. Sessions accumulate; they are not reset per request.

**Multi-user first.** Every user gets a fenced userspace. Anything a user does — install a package, run a service, bind a port, write files, execute code — happens inside that fence and cannot reach another user's space or degrade the service for anyone else.

One rule keeps these from fighting: **the kernel has no opinions.** The kernel knows about users, userspaces, sessions, a pipeline of steps, the variables those steps mutate, and packages. That is the whole list. Skills, tools, memory, MCP, RAG, gateways, providers — anything domain-specific — is a package. Adding a capability to Thetis never means changing the kernel; it means writing a package.

## 2. MVP

The MVP is reached when the harness can work on itself: from inside a conversation, a user asks Thetis to change how Thetis behaves, Thetis writes a package into that user's space, installs it, and the change is live on the next turn — no kernel change, no redeploy.

| Component | Minimum for MVP |
|---|---|
| Kernel | Config-driven pipeline; one built-in provider-call step; session persistence |
| Fence | One microVM (or equivalent) per user with filesystem, network, and process isolation |
| Package manager | Local scoped store inside each userspace; install from a git URL |
| Provider | One provider package (local or OpenRouter) |
| Gateway | One gateway package (CLI or minimal HTTP) |
| Tool | One "run code in my userspace" tool package, so the model can write, build, and test packages |

Everything else in this document is designed so it can arrive later as a package.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **User** | An identity. Owns exactly one userspace and a package scope, `@<user>/*`. |
| **Userspace** | The fenced environment for one user: a microVM (or equivalent sandbox) with its own filesystem, network namespace, and process table. All of a user's sessions live here. |
| **Session** | One conversation plus its harness state and the pipeline it runs. Belongs to one user. Subagents are sessions too. |
| **Turn** | One pass through a session's pipeline, triggered by input from a gateway or from a prior turn. |
| **Conversation** | The message history of a session. A pipeline variable. |
| **Call** | The parameterized request to a provider: model, messages, system prompt, tools, sampling parameters. A pipeline variable — built by steps, executed by a step. |
| **Harness** | The persistent state packages keep for a session: memory, active skills, subagent handles, anything. A pipeline variable. |
| **Kernel** | The trusted component that enumerates and runs pipelines, owns sessions, and enforces the fence. Runs on bare metal or equivalent. |
| **Pipeline** | The ordered list of steps run for a turn. Produced by the enumerator from configuration. |
| **Step** | A unit of behavior contributed by a package. Receives the variables, returns mutations. |
| **Package** | The unit of everything: a directory with a `package.json` and a `thetis` field. Has a scope, a type, and a source (local build or git). |
| **Gateway** | A package type that exposes an endpoint through which something outside Thetis talks to it. |
| **Provider** | A package type that sources models and advertises which ones it can serve. |
| **Fence** | The boundary the kernel enforces around each userspace. |

## 4. Service topology

The service has two planes.

**Service plane** — trusted, runs on the host. Contains the kernel, the package manager's registry, and the provider registry. No user-authored code runs here.

**Userspaces** — one per user, each a microVM. Contains the user's sessions, their private package builds, and any long-running services their packages start. All user-authored code — which is to say all package code — runs here. System packages (`@thetis/*`) run in a system userspace that is fenced like any other.

Gateways sit at the edge. They are packages, so they run in a fence like anything else, and they reach the kernel only through its session API.

## 5. Kernel

### 5.1 Data-driven by construction

The kernel executes configuration; it does not contain behavior. A turn is:

1. A gateway delivers input to a session.
2. The kernel enumerates the pipeline for that session: `enumerate(config, session) → Step[]`. The enumerator is itself configuration — a step that produces steps — and can be replaced by a package.
3. The kernel runs each step in order. A step receives the session's variables and returns mutations to them.
4. When the pipeline ends, the kernel persists the conversation and harness state in the userspace and emits the turn's events to the gateway.

The pipeline is data; the enumerator is data; each step is a package. This is what lets the harness rewrite itself: changing Thetis's behavior is a matter of writing or replacing the data the kernel executes.

### 5.2 The three variables

Every step sees the same three things and may mutate any of them.

| Variable | What it is | Typical mutations |
|---|---|---|
| `conversation` | The message history | compact, summarize, inject, redact, reorder |
| `call` | The parameterized provider call | set the model, build the system prompt, attach tools, set sampling params |
| `harness` | Persistent per-session state owned by packages | write memory, mark a skill active, register a subagent |

Nothing is privileged. A memory package that injects context and a compaction package that trims history are the same kind of thing, differing only in what they return.

### 5.3 Step contract

```ts
interface StepContext {
  session: { id: string; user: string; parent?: string }; // parent is set for subagents
  turn: { id: string; input: Message[] };
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  packages: PackageQuery;   // what is installed in this userspace: has(), get(), list()
  env: UserspaceHandle;     // fs / exec / net, scoped to the fence
}

type StepResult = Partial<Pick<StepContext, "conversation" | "call" | "harness">>;
type Step = (ctx: StepContext) => Promise<StepResult>;
```

A step may also spawn sessions (subagents), start services, or call tools — all through `env` and `packages`, all inside the fence.

### 5.4 Where steps run

Decision: **step bodies execute inside the user's fence, not in the service plane.**

Step code is package code, and package code is user-authored. If steps ran in the service plane, every user package would be running as trusted code. So the kernel dispatches each step into the userspace along with the variables, and receives the mutations back. The only code the kernel runs itself is its own: enumerate, dispatch, apply, persist, and the built-in provider-call step.

This is the mechanism behind "the kernel fences each userspace." The fence is not a check bolted onto step execution; it is where step execution happens.

### 5.5 Session API

```ts
sessions.create(user, opts)        → SessionRef
sessions.send(session, input)      → AsyncIterable<TurnEvent>
sessions.inspect(session)          → { conversation, harness, pipeline, status }
sessions.list(user)                → SessionRef[]
```

Every call is authorized against a user; a session is reachable only by its owner.

## 6. Userspace and environment isolation

### 6.1 One userspace per user

A userspace is created on a user's first turn and lives until the user is removed. It holds all of that user's sessions — including subagent sessions — so anything one session builds is available to every other session of the same user.

### 6.2 What the fence encloses

A userspace is a microVM (Firecracker-class) or an equivalent sandbox. It owns:

- **Filesystem** — private and persistent. Holds session state, the `@<user>/*` package store, and whatever packages write.
- **Network** — its own namespace and address. Binding a port is free; being reachable from outside the fence is a separate grant (§6.4).
- **Processes** — its own process table. Packages may start services that run for as long as the package is installed; uninstalling the package stops them.
- **Compute** — CPU, memory, and disk quotas set per userspace.

### 6.3 What crosses the fence

Only these, and only through the kernel:

| Crossing | Direction | Carried by |
|---|---|---|
| Step dispatch | service plane → userspace | kernel |
| Mutated variables | userspace → service plane | kernel |
| Package install / fetch / share | both | package manager, via the kernel |
| Provider call | userspace → service plane → provider | the provider-call step |
| Turn events | userspace → gateway | kernel session API |
| Published port | outside → userspace | service plane, by policy (§6.4) |

### 6.4 Publishing a port

A package declares the ports it wants exposed and a target; the userspace's fence policy decides whether the grant is allowed.

```json
"thetis": { "type": "gateway", "publish": [{ "port": 8777, "to": "host" }] }
```

| Target | Reachable from | Granted to |
|---|---|---|
| `host` | the host's own interface | the system userspace only |
| `user` | a per-user address the service plane maps | any userspace |
| `internal` | the service plane and system packages | any userspace |

The kernel does nothing above L4. Hostname routing, TLS termination, and HTTP-level delegation are packages (§8).

### 6.5 The guarantee

No user can perform any operation that affects another user's userspace or the service plane. A package cannot reach past the fence because there is no API that would let it.

### 6.6 Subagents

A subagent is a session whose `parent` is another session, in the same userspace. It shares the filesystem and installed packages with its parent and runs its own pipeline.

## 7. Packages

### 7.1 Everything is a package

A package is a directory with a `package.json`. Thetis reads the standard fields (`name`, `version`, `dependencies`, `peerDependencies`, `main`) and one extra, `thetis`, which declares what the package contributes. Package types are an open set: `skill`, `skill-type`, `loader`, `tool`, `memory`, `mcp`, `mcp-server`, `rag`, `gateway`, `provider`, `enumerator`, `service`.

### 7.2 Manifest

```json
{
  "name": "@alice/skill-loader-all",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "peerDependencies": { "@thetis/contracts": "^0" },
  "thetis": {
    "type": "loader",
    "steps": [ { "id": "embed-all-skills", "phase": "prompt", "export": "embedSkills" } ]
  }
}
```

`steps` declares which exports the enumerator may schedule and where in the pipeline they belong. The phase vocabulary (`history`, `prompt`, `tools`, `call`, `after`) is defined by the default enumerator, not by the kernel.

### 7.3 Scopes and sources

- `@thetis/*` — system packages, shipped with the service, resolvable from every userspace.
- `@<user>/*` — owned by that user. Private by default: stored in the user's fence, resolvable only there.
- Git — any package fetchable from a repository URL, installed into the user's store.

The package manager keeps a registry in the service plane and a store in each userspace.

### 7.4 Dependencies and capability checks

- **Hard requirement** — `peerDependencies`. A package that only makes sense alongside another declares it and will not install without it.
- **Conditional behavior** — at run time, `ctx.packages.has("@thetis/claude-skills")` and branch.

### 7.5 Lifecycle

write → build → install (into `@<user>/*`) → activate → iterate → share

## 8. Gateways

A gateway is a package that exposes an endpoint through which something outside Thetis talks to it. It authenticates the caller and maps them to a user, creates or selects a session and sends turns, renders turn events, and may inspect running state. Gateways talk to the kernel through the session API and never touch a userspace directly. System gateways run in the system userspace and publish to `host`; user gateways run in the user's fence. HTTP-level delegation and per-user ingress are packages.

## 9. Providers

A provider is a package that sources models. Steps only ever see a `ProviderCall`:

```ts
interface Provider {
  models(): Promise<ModelDescriptor[]>;
  call(call: ProviderCall): AsyncIterable<ProviderEvent>;
}
```

The provider registry in the service plane aggregates what every installed provider advertises. `call.model` selects the provider. System providers hold service credentials and run in the system userspace; a user-installed provider runs in that user's fence with that user's credentials.

## 10. The continual harness

The `harness` variable is persisted per session at the end of each turn and handed back at the start of the next. Memory packages may additionally persist per user, across sessions, by writing to the userspace filesystem. A background process that refines the harness between turns is a `service` package.

## 11. Open questions

- User addresses for `user`-published ports.
- Whether a replacement enumerator must honor the default phase names.
- Ordering conflicts between packages claiming the same phase.
- Sharing `@user/*` packages: review, versioning, revocation.
- Identity: gateway concern with a kernel-side contract, or a service-plane component.
- Quotas and billing.
- Verifying that a hostile enumerator can only hurt its own user.

## 12. How the MVP implementation maps to this document

| Concept | Implementation |
|---|---|
| Kernel | `packages/kernel`: authority only. Its vocabulary is `packages/contracts`; its mechanism is `packages/lib`; the composition root `createKernel` and the `Container` wiring are `packages/host` |
| Fence | `ProcessFence` in `packages/sandbox` + `packages/userspace-agent`; bubblewrap namespaces when available |
| Session API | `SessionApi` (`create`, `send`, `ask`, `inspect`, `list`) |
| Enumerator | `Enumerator.defaultPlan` from config phases, replaceable via `config.enumerator` |
| Built-in call step | `ProviderCallStep` (streams provider events, runs tools in the fence, loops) |
| Package manager | `PackageManager` + `PackageRegistry`; local path or git; per-userspace `store/node_modules` |
| Kernel RPC from the fence | `createRpcHandler`: `packages.*`, `sessions.*`, authorized as the fence's user |
| Provider | `@thetis/provider-openrouter` in the system userspace |
| Gateway | `@thetis/gateway-cli` (runs on the host; a CLI needs the terminal) |
| Tool | `@thetis/tool-exec` |
| Default harness | `@thetis/harness-core` |
