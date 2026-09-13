# 11 Testing

All tests use the Node test runner (`node:test`) and `node:assert/strict`. No test framework is installed. Tests live in `packages/<name>/test`. `npm test` builds and then runs `packages/*/dist/test/**/*.test.js`.

## 1. Suites

| File | Type | Content |
|---|---|---|
| `test/loc.test.ts` | Guard | Counts kernel lines of code. Fails at 2,000 or more. Prints a per-file table. |
| `test/unit.test.ts` | Unit | Container, user store, auth service, manifest validation, enumerator plan and validation, async queue. |
| `test/e2e.test.ts` | End-to-end | The real `ProcessFence` and agent with a fixture provider. No network. |
| `packages/gateway-web/test/gateway.test.ts` | End-to-end | The web gateway over HTTP, in-process and inside the system fence. See [15-web-gateway.md](15-web-gateway.md) section 10. |

## 2. The end-to-end suite

### 2.1 Setup

The `before` hook:

1. Creates a temporary directory.
2. Creates `system-packages/` inside it with symbolic links to `packages/harness-core`, `packages/tool-exec`, and the fixture `test/fixtures/provider-echo`.
3. Builds a config with `defaultConfig`, then sets: `systemPackagesDir` to that directory, `model` to `echo`, `fence.sandbox` from `THETIS_TEST_SANDBOX` (default `auto`), `systemPackages` to the three packages, `packages["@thetis/provider-echo"]` to `{ tag: "t1" }`, `requestTimeoutMs` to 60000.
4. Calls `createKernel` and rebinds `T.log` to a function that prints only when `THETIS_TEST_VERBOSE` is set.
5. Creates the users `alice` and `bob`.

The `after` hook shuts the kernel down and deletes the directory.

### 2.2 Cases

| Case | Verifies |
|---|---|
| first turn seeds the userspace | System packages are linked on first use. The provider round-trip returns `echo: hello (t1)`. The conversation has two messages. |
| harness steps build the system prompt | `system?` returns text that contains `You are Thetis` and the package list. `tools?` lists the tool-exec tools. |
| tool loop | `run: <cmd>` makes the provider call `exec`. The tool runs in the fence. The conversation is `user, assistant, tool, assistant`. |
| self-extension | A package written into `home/packages/hello` installs through the `install_package` tool over RPC. Its `prompt` step and `after` step are active on the next turns. Its tool is attached. The harness state persists. |
| scope and visibility | Alice cannot install `@bob/evil`. A path outside the userspace is rejected. Bob does not see alice's tool. Bob cannot inspect alice's session. |
| cancel mid-stream | `cancel` during a `slow:` reply ends the turn with the code `cancelled`. The partial text is saved as an assistant message. The session is idle and accepts the next turn. |
| cancel a tool | `cancel` during `run: sleep 30` kills the process. The turn ends in under 10 seconds. |
| control socket | A raw client pings, lists users, creates a session, streams a turn with `sessions.send`, and receives error codes. The socket file is removed on close. |
| rpc scoping | Alice's handler refuses `as` and `auth.*`. The system handler lists bob's sessions with `as` and streams a turn for alice through `sessions.send`. |
| suspended users | `create` fails for a suspended user. |
| fence isolation | With `bwrap`, a command in alice's fence cannot read `users.json`, bob's userspace, or other entries of the data directory. Skipped without `bwrap`. |

### 2.3 The fixture provider

`test/fixtures/provider-echo/index.js` reacts to the last message:

| Last message | Reply |
|---|---|
| `run: <cmd>` and the `exec` tool is attached | A `tool_call` for `exec` with `{ cmd }`. |
| `install: <path>` | A `tool_call` for `install_package` with `{ source }`. |
| `slow: <words>` | One `text` event per word, 50 milliseconds apart. |
| `system?` | The text of `call.system`. |
| `tools?` | The tool names, comma-separated. |
| a `tool` message | `tool said: <content>`. |
| anything else | `echo: <text> (<config.tag>)`. |

## 3. Environment variables

| Variable | Effect |
|---|---|
| `THETIS_TEST_SANDBOX` | `none` forces the unfenced mode. Default `auto`. |
| `THETIS_TEST_VERBOSE` | Any value prints the agent's `stderr`. |

## 4. Write a new test

- Unit tests import kernel classes from `../src/...js`. Construct them directly with fakes. Use `mkdtempSync` for file stores and delete the directory in `finally`.
- End-to-end tests add a `test(...)` to `e2e.test.ts` and use the shared `kernel`. Use `collect(kernel.sessions.send(...))` to gather events and text. Extend the fixture provider when a new model behavior is needed.
- A test of a fence crossing must run through the real agent. Do not mock the agent in an end-to-end test.
- After a kernel change, run `npm test` and read the line count.

## 5. Run one file

```sh
npm run build
node --test packages/kernel/dist/test/unit.test.js
node --test --test-name-pattern "tool loop" packages/kernel/dist/test/e2e.test.js
```

## 6. What is not tested

- The OpenRouter provider against the real API. Manual check: `node bin/thetis.js send --user <id> "hello"`.
- Git installs. The code path is implemented and not exercised by a test.
- The CLI parser and renderer.
- Behavior under a microVM fence.
