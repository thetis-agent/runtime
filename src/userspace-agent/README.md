# Runtime module: userspace-agent

The guest side of the fence. The sandbox starts one long-lived Node process per userspace, and that process is this package: `dist/src/userspace-agent/agent.js`, the `agentPath` of the configuration. It runs inside each fence, the system userspace fence included. It loads package modules from the userspace store and runs steps, tools, enumerators, providers, and services when the kernel asks. Package code never starts it and never talks to it directly; it sees the environment the agent builds.

## What it provides

Nothing in `thetis`. Not installable, and not a library: an executable with no exports. It imports `@thetis/runtime/contracts` for its types and `@thetis/runtime/lib/rpc-frames` for the framing.

The protocol is one JSON object per line: requests in on `stdin`, events and results out on `stdout`, logs on `stderr`. The kernel forwards each `stderr` line to its log with the prefix `[<user id>]`. The agent redirects `console.log`, `console.info`, and `console.debug` to `stderr` and exits when `stdin` closes. Package code that writes to `process.stdout` directly corrupts the protocol.

| Operation | What the agent does |
|---|---|
| `ping` | Answers `pong`. The kernel sends it once after the fence opens. |
| `exec` | Runs a command with `/bin/bash` in the home directory. Output is capped at 30,000 characters per stream. |
| `step` | Loads the export, calls it with the step context plus a `packages` query and `env`, returns `conversation`, `call`, and `harness`. |
| `tool` | Loads the export, calls it with the arguments and a `ToolEnv` (`env` plus `session` and `config`). |
| `enumerate` | Loads the export, calls it with `session`, `packages`, and `phases`. |
| `provider.models`, `provider.call` | Builds the provider once per package, export, and configuration; streams each `ProviderEvent` as an event line. |
| `service.start`, `service.stop` | Starts the export with a `ServiceEnv` (`env` plus `config` and `log`) and keeps one instance per package; `stop` calls its `stop()`. Every service exits with the agent. |

A `{ "cancel": <id> }` line aborts a request: `exec` kills its process, and `provider.call` hands the signal to the provider so the HTTP request itself ends, rather than only stopping the reading of it. Handing it over is what makes the difference for a request that never produces an event at all: the loop that reads the stream would never reach its own check on the signal, because it is waiting for the event that is not coming.

While an operation is in flight the agent sends `{ "id": <id>, "alive": true }` every `THETIS_HEARTBEAT_MS` milliseconds (5,000 when the environment does not say). It carries nothing and is never relayed to anyone: it is how the kernel tells a fence that is wedged from one that is quiet because it is working. The kernel times a request by the silence on it and not by how long the work takes -- a `step` is a whole turn, and a tool running a build says nothing for minutes while being perfectly healthy -- so this is the one thing it needs from in here. The interval is the kernel's choice, passed in at spawn, because the two ends have to agree on it. The beat starts with the operation and stops with it, so what it reports is this request still being worked on and not merely a process that exists.

### The allowance: what the beat took away, put back here

The beat is unconditional, and that removed the kernel's timer as the bound on *everything*. A step that awaits something which never resolves would keep the fence beating and nothing would ever end the turn. So the agent bounds its own operations: each one runs against an allowance of `THETIS_STEP_DEADLINE_MS` (the kernel passes half the silence it allows a fence; 300 s under the default 600 s, and 300 s when the environment says nothing), and one that runs past it has its signal aborted and its request failed.

Three operations are exempt, each for its own reason:

| Exempt | Why |
|---|---|
| the `execute` step | The turn's long work by design -- a model answering, tools running under it, a build that says nothing for twenty minutes -- and watched from the inside by `@thetis/harness-core`, which asks about slow work instead of killing it. An allowance over this would be the ten-minute cap on a working turn all over again. |
| `provider.call` | The same: a model streaming, with the provider's own stall watch over it. |
| `exec` | Bounded already by its own `timeoutMs` (default 120 s) and always settles. A package build is deliberately allowed to run longer than the allowance. |

Everything else is fast by nature -- a step that builds a prompt, lists tools or records the call, an enumerator, a service starting, a provider listing its models -- and five minutes of that is a bug rather than slowness. The phase comes from the kernel on the `step` operation, and when nothing names it the package's own manifest declaration does: a step has to be declared to be scheduled, so between the two the phase is always known. A step whose phase *neither* names is treated as a short one, because guessing "unbounded" is how a turn hangs for ever.

What fails is the package, not the workspace. The request comes back with the sentence below and no stack (the stack would be the timer's, which tells nobody anything about the code that hung); the kernel gives it the code `package`, the turn ends with it, and the fence carries on serving that person's gateway, terminal and sessions:

```
@thetis/skills-hybrid#pin in the prompt phase did not finish within 300 s and was stopped. Only the
execute phase may run long; a step that builds a prompt, lists tools or records the call is expected to
take milliseconds, so this is a bug in that package rather than a slow turn. The workspace is
unaffected: its other services, sessions and this fence are still running.
```

The allowance is raced against the work rather than enforced inside it: the point is to end an operation that is not going to end by itself, and one that ignores its signal would sit there being asked nicely for ever. The signal is aborted first all the same, so work that does watch it stops rather than running on unwatched.

A module is loaded from `<store>/node_modules/<package>`: `main` from its `package.json` (default `index.js`), imported with the query `?v=<modification time>`, so a changed file is a new module. The named export must be a function.

The agent reaches the kernel through RPC lines on `stdout`. The `KernelClient` it builds has `packages.install`, `uninstall`, `delete`, `list`; `sessions.create`, `ask`, `send`, `cancel`, `list`, `inspect`; `models`; `config.show`, `set`, `unset`, `effective`; `auth.login`, `authenticate`, `logout`; and `operator.call`. Every method acts as the fence's own user; the kernel authorizes it on each call.

## Use

What package code receives is the environment this agent builds. A tool:

```ts
import type { Tool } from "@thetis/runtime/contracts";

export const listPackages: Tool = async (args, env) => {
  const { code, stdout } = await env.exec("ls", { cwd: "." });
  const installed = await env.kernel.packages.list();
  return { code, stdout, installed: installed.map((p) => p.name) };
};
```

| Field of `env` | Content |
|---|---|
| `cwd`, `root`, `store`, `shared` | The home directory, the userspace root, the package store, the shared directory. From `THETIS_HOME_DIR`, `THETIS_USERSPACE`, `THETIS_STORE`, `THETIS_SHARED`. |
| `exec(cmd, opts)` | `opts.cwd` is relative to home; `opts.timeoutMs` defaults to 120000. Returns `{ code, stdout, stderr }`. |
| `readFile(path)`, `writeFile(path, content)` | UTF-8, relative to home. `writeFile` creates parent directories. |
| `kernel` | The kernel client above. |
| `storage(namespace?)` | A `Store` of this package's documents: each method is a `store.*` RPC that names the package, and the kernel prefixes the namespace with the user and that name. The base env has no package and throws; only the env a step, tool or service receives has one. |
| `session`, `config` | Tools only: `{ id, user, parent? }` and the tool's package configuration. |

A service logs with `env.log(line)`, which writes to `stderr` with the package name as prefix, and returns `{ stop }` when it has something to close.

## Files

| File | Content |
|---|---|
| `agent.ts` | The agent: the kernel client, the environment, module loading, the operations, cancel, and the frame loop. |
| `env.ts` | `storageClient` and `buildEnvFor`: the per-package env, kept apart from the agent so it can be tested without booting one. |

## Tests

`test/env.test.ts` checks the per-package env against a fake RPC: the five store calls, `null` to `undefined`, the base env refusing storage. `test/host/e2e.test.ts` runs the real agent inside the real fence for every case, and `packages/gateway-web/test/gateway.test.ts` runs the login target and a gateway as its services. Run every test with `npm test` from the runtime root.
