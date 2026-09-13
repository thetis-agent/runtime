# 01 Overview

## 1. What Thetis is

Thetis is a multi-user language model service. The model does its work by writing code. That code runs in the user's own fenced environment. The code can change the harness the model runs inside. The harness is the prompt, the tools, the memory, and the subagents.

Thetis has three properties.

- **Recursive.** A conversation can change how Thetis behaves. The model writes a package, installs it, and the change is live on the next turn.
- **Continual.** The harness state persists. Each turn reads the state of the previous turn and writes state for the next turn.
- **Multi-user.** Each user has one fenced userspace. Code in one userspace cannot read or change another userspace.

One rule keeps the design stable: **the kernel has no opinions.** The kernel knows users, userspaces, sessions, a pipeline of steps, three variables, and packages. All other behavior is in packages.

## 2. Repository layout

The directory `runtime` is a git repository and the npm workspace root. In this documentation `<root>` means the `runtime` directory. The directory `runtime/packages` is a second git repository. The `runtime` repository references it as a git submodule.

```
runtime/                 <root>. Git repository. npm workspace root.
  .env                   Secrets and THETIS_HOME. Not committed.
  .env.example           Template for .env.
  .gitignore
  .gitmodules            Declares packages/ as a submodule.
  .thetis/               Default data directory (THETIS_HOME=.thetis in .env). Not committed.
  bin/thetis.js          Command-line entry point.
  bin/thetis-web.js      Web gateway entry point.
  docs/                  This documentation.
  package.json           Workspace root. Workspaces are packages/*.
  tsconfig.json          TypeScript project references to all packages.
  tsconfig.base.json     Shared compiler options.
  node_modules/          Installed dependencies and workspace links. Not committed.
  README.md              Short user guide.
  packages/              Git submodule. Its own repository. All packages, including the kernel.
    kernel/              @thetis/kernel. The trusted service plane.
    userspace-agent/     @thetis/userspace-agent. Runs inside each fence.
    provider-openrouter/ @thetis/provider-openrouter. Provider package.
    harness-core/        @thetis/harness-core. Default prompt and tool attachment.
    tool-exec/           @thetis/tool-exec. Code execution and package install tools.
    gateway-cli/         @thetis/gateway-cli. The command-line gateway.
    gateway-web/         @thetis/gateway-web. The web gateway.
```

**Note:** The submodule URL in `.gitmodules` is `./packages`. Set it to the real remote URL of the packages repository before you push. Run `git submodule update --init` after a fresh clone of `runtime`.

## 3. Components

| Component | Package | Where it runs | Function |
|---|---|---|---|
| Kernel | `@thetis/kernel` | Host process (service plane) | Users, userspaces, sessions, pipeline, package manager, provider registry, fence control. |
| Userspace agent | `@thetis/userspace-agent` | Inside each fence | Loads package modules. Runs steps, tools, enumerators, and providers. |
| Provider | `@thetis/provider-openrouter` | System userspace fence | Sends calls to OpenRouter. Streams the reply. |
| Harness | `@thetis/harness-core` | Each user's fence | Limits history. Builds the system prompt. Attaches tools. |
| Tools | `@thetis/tool-exec` | Each user's fence | `exec`, `read_file`, `write_file`, `install_package`, `uninstall_package`, `spawn_subagent`. |
| Gateway | `@thetis/gateway-cli` | Host process | The `thetis` command. Uses the session API only. |
| Gateway | `@thetis/gateway-web` | Host process | The `thetis-web` command. A browser interface with password login. See [15-web-gateway.md](15-web-gateway.md). |

## 4. The two planes

The **service plane** is the host process that runs the kernel. No package code runs in the service plane.

A **userspace** is one fenced environment for one user. All package code runs in a userspace. System packages run in the system userspace. The system userspace belongs to the user `_system`.

The kernel is the only bridge between the planes. See [03-fence.md](03-fence.md).

## 5. One turn in five steps

1. A gateway sends input to a session.
2. The kernel lists the installed packages of the userspace. The kernel builds the pipeline.
3. The kernel sends each step into the fence with the three variables. The step returns mutations. The kernel validates and applies them.
4. The built-in provider call step sends the call to a provider. The step runs tool calls in the fence until the model stops.
5. The kernel saves the conversation and the harness state. The gateway receives the turn events.

See [04-pipeline.md](04-pipeline.md) for the details.

## 6. The three variables

| Variable | Type | Content |
|---|---|---|
| `conversation` | `Message[]` | The message history of the session. |
| `call` | `ProviderCall` | The model, the system prompt, the messages, the tools, and the sampling parameters. |
| `harness` | `HarnessState` | A JSON object. Packages keep per-session state here. |

Every step receives all three variables. Every step can return new values for any of them.

## 7. Current status

The MVP is complete. A user can ask Thetis to change its behavior in a conversation. Thetis writes a package, tests it, installs it, and the change is live on the next turn. See [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md) for the gaps.
