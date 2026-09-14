# 11 Testing

All tests use the Node test runner (`node:test`) and `node:assert/strict`. No test framework is installed. Tests live in `packages/<name>/test`. `npm test` builds and then runs `packages/*/dist/test/**/*.test.js`.

## 1. Suites

| File | Type | Content |
|---|---|---|
| `packages/kernel/test/loc.test.ts` | Guard | Counts kernel lines of code. Fails at 1,200 or more. Prints a per-file table. |
| `packages/kernel/test/boundaries.test.ts` | Guard | Reads every import of `@thetis/*` in `packages/*/src`. Fails when a layer imports upward, or when a package other than `host` and `gateway-cli` imports `@thetis/kernel`. See section 1.1. |
| `packages/kernel/test/unit.test.ts` | Unit | User store, auth service, manifest validation, enumerator plan and validation, config and redaction. |
| `packages/lib/test/lib.test.ts` | Unit | Container, async queue, package sources, the JSON directory store, the RPC framing. |
| `packages/host/test/e2e.test.ts` | End-to-end | The real `ProcessFence` and agent with a fixture provider. No network. |
| `packages/gateway-web/test/gateway.test.ts` | End-to-end | The door, the login target, and one gateway per person, in-process and then inside real fences. See [15-web-gateway.md](15-web-gateway.md) section 10. |
| `packages/prompt-cache/test/*.test.ts` | Unit | The planner, the policy and hint rules, both wire adapters, usage normalization, the fingerprint diagnosis, and the step. |

### 1.1 The boundary rules

| Package | May import |
|---|---|
| `contracts` | nothing from `@thetis` |
| `lib` | `contracts` |
| `sandbox` | `contracts`, `lib` |
| `kernel` | `contracts`, `lib` |
| `host` | `contracts`, `lib`, `sandbox`, `kernel` |

Only `host` and `gateway-cli` may import `@thetis/kernel` in `src`. Tests are not checked: `packages/gateway-web/test` imports the host and the kernel.

## 2. The end-to-end suite

The suite is in `packages/host/test/e2e.test.ts`. Its fixture is in `packages/host/test/fixtures`.

### 2.1 Setup

The `before` hook:

1. Creates a temporary directory.
2. Creates `system-packages/` inside it with symbolic links to `packages/harness-core`, `packages/tool-exec`, `packages/prompt-cache`, and the fixture `packages/host/test/fixtures/provider-echo`.
3. Builds a config with `defaultConfig`, then sets: `systemPackagesDir` to that directory, `model` to `echo`, `fence.sandbox` from `THETIS_TEST_SANDBOX` (default `auto`), `systemPackages` to the four packages, `packages["@thetis/provider-echo"]` to `{ tag: "t1" }`, `packages["@thetis/prompt-cache"]` to `{ explicitVendors: ["echo"], ttl: "1h" }`, `requestTimeoutMs` to 60000.
4. Calls `createKernel` and rebinds `T.log` to a function that prints only when `THETIS_TEST_VERBOSE` is set.
5. Creates the users `alice` and `bob`.

The `after` hook shuts the kernel down and deletes the directory.

### 2.2 Cases

| Case | Verifies |
|---|---|
| first turn seeds the userspace | System packages are linked on first use. The provider round-trip returns `echo: hello (t1)`. The conversation has two messages. |
| the prompt-cache step hands the provider a hint | `hints?` returns `call.hints`. The `cache` hint has the configured strategy and lifetime, no lifetime that is not configured, and an affinity token. After two turns the harness has `turns: 2` and no divergence. |
| harness steps build the system prompt | `system?` returns text that contains `You are Thetis` and the package list. `tools?` lists the tool-exec tools. |
| tool loop | `run: <cmd>` makes the provider call `exec`. The tool runs in the fence. The conversation is `user, assistant, tool, assistant`. |
| self-extension | A package written into `home/packages/hello` installs through the `install_package` tool over RPC. Its `prompt` step and `after` step are active on the next turns. Its tool is attached. The harness state persists. |
| scope and visibility | Alice cannot install `@bob/evil`. A path outside the userspace is rejected. Bob does not see alice's tool. Bob cannot inspect alice's session. |
| cancel mid-stream | `cancel` during a `slow:` reply ends the turn with the code `cancelled`. The partial text is saved as an assistant message. The session is idle and accepts the next turn. |
| cancel a tool | `cancel` during `run: sleep 30` kills the process. The turn ends in under 10 seconds. |
| control socket | A raw client pings, lists users, creates a session, streams a turn with `sessions.send`, and receives error codes. The socket file is removed on close. |
| rpc identity | Alice's handler cannot log in. The system handler logs alice in. Alice's handler resolves her token; bob's handler gets `null` for it and cannot revoke it. A turn streams through alice's own handler. |
| operator methods | Alice's handler is refused. An admin's handler lists users, another person's packages, and the journal. |
| promote | The promoted package is in the promoted directory and every userspace; the configuration file is untouched; bob's fence can read it. |
| suspended users | `create` fails for a suspended user. |
| fence isolation | With `bwrap`, a command in alice's fence cannot read `users.json`, bob's userspace, or other entries of the data directory, and cannot write the shared directory; it can read the promoted packages. Skipped without `bwrap`. |

### 2.3 The fixture provider

`packages/host/test/fixtures/provider-echo/index.js` reacts to the last message:

| Last message | Reply |
|---|---|
| `run: <cmd>` and the `exec` tool is attached | A `tool_call` for `exec` with `{ cmd }`. |
| `install: <path>` | A `tool_call` for `install_package` with `{ source }`. |
| `slow: <words>` | One `text` event per word, 50 milliseconds apart. |
| `system?` | The text of `call.system`. |
| `tools?` | The tool names, comma-separated. |
| `hints?` | `call.hints` as JSON. |
| a `tool` message | `tool said: <content>`. |
| anything else | `echo: <text> (<config.tag>)`. |

## 3. Environment variables

| Variable | Effect |
|---|---|
| `THETIS_TEST_SANDBOX` | `none` forces the unfenced mode. Default `auto`. |
| `THETIS_TEST_VERBOSE` | Any value prints the agent's `stderr`. |

## 4. Write a new test

- Unit tests import classes from `../src/...js` of their own package. Construct them directly with fakes. Use `mkdtempSync` for file stores and delete the directory in `finally`.
- End-to-end tests add a `test(...)` to `packages/host/test/e2e.test.ts` and use the shared `kernel`. Use `collect(kernel.sessions.send(...))` to gather events and text. Extend the fixture provider when a new model behavior is needed.
- A test of a fence crossing must run through the real agent. Do not mock the agent in an end-to-end test.
- After a kernel change, run `npm test` and read the line count and the boundary test.

## 5. Run one file

```sh
npm run build
node --test packages/kernel/dist/test/unit.test.js
node --test packages/kernel/dist/test/boundaries.test.js
node --test --test-name-pattern "tool loop" packages/host/dist/test/e2e.test.js
```

## 6. What is not tested

- The OpenRouter provider against the real API. Manual check: `node bin/thetis.js send --user <id> "hello"`. The line under the reply shows the cache accounting; a second turn in the same session must show `cached` above 80%.
- Git installs. The code path is implemented and not exercised by a test.
- The CLI parser and renderer.
- Behavior under a microVM fence.
