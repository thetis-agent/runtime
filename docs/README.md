# Thetis documentation

This directory contains the technical documentation for Thetis. The documents use Simplified Technical English (ASD-STE100). Each sentence gives one fact or one instruction. Read the documents in the order below.

| Document | Content |
|---|---|
| [01-overview.md](01-overview.md) | What Thetis is. The repository layout. The components. |
| [02-kernel.md](02-kernel.md) | The layering rule, the five service-plane packages, the kernel modules, the container, the service tokens, and the line-count limit. |
| [03-fence.md](03-fence.md) | The fence, the process sandbox, the userspace agent, and the wire protocol. |
| [04-pipeline.md](04-pipeline.md) | Phases, enumeration, steps, the built-in provider call, the tool loop, and turn events. |
| [05-packages.md](05-packages.md) | The package manifest, package types, install rules, the store, and the registry. |
| [06-sessions-and-users.md](06-sessions-and-users.md) | Users, roles, moderation, sessions, subagents, and the session API. |
| [07-providers.md](07-providers.md) | The provider contract, model resolution, and the OpenRouter package. |
| [08-cli.md](08-cli.md) | All commands of the `thetis` command-line gateway. |
| [09-configuration.md](09-configuration.md) | The configuration file, every field, the defaults, and the data directory. |
| [10-development.md](10-development.md) | How to build, run, test, and change Thetis. Code rules. |
| [11-testing.md](11-testing.md) | The test suites, the fixtures, and how to write new tests. |
| [12-security.md](12-security.md) | Trust boundaries, what the system enforces, and what it does not enforce. |
| [13-limitations-and-roadmap.md](13-limitations-and-roadmap.md) | Known gaps and the recommended order of future work. |
| [14-glossary.md](14-glossary.md) | Definitions of all terms. |
| [15-web-gateway.md](15-web-gateway.md) | The browser interface: commands, routes, the event stream, and its trust model. |
| [16-prompt-cache.md](16-prompt-cache.md) | Prompt caching: the policy, the breakpoints, the hint, the diagnostics, and the rules for package authors. |
| [17-control-panel.md](17-control-panel.md) | The control panel of the web gateway: sections, routes, and the role checks. |
| [18-marketplace.md](18-marketplace.md) | Registries, the marketplace service, the index file, search, and install. |
| [19-exa.md](19-exa.md) | The Exa tools: web search, contents, summaries, answers, research runs, and the configuration key. |
| [20-tools.md](20-tools.md) | The tools the model works with: bounded file tools, the plan, and questions for the person. |
| [21-benchmarks.md](21-benchmarks.md) | Measuring the harness: the suites, how a package opts in, what may be compared, and the artifact each package carries. |
| [22-projects.md](22-projects.md) | Projects: named workspaces with project directories, instructions, and tool switches; the files, the steps, the commands, the switcher, and the settings place. |
| [23-skills.md](23-skills.md) | Skills: the SKILL.md format, the sources, the `@thetis/skills` library, the three loaders, the harness state, the bench, and the limits. |
| [24-terminal.md](24-terminal.md) | The terminal: long-lived shell sessions in a person's fence, the pty and its marks, the ring buffer, the five tools, the shelf, the limits, and what it cannot do. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The original design specification. It is the reference for design decisions. It is not written in STE. |

## Conventions in these documents

- Paths are relative to the `runtime` directory unless the text says otherwise.
- `<root>` is the `runtime` directory. It is the git repository and the npm workspace root. `$THETIS_HOME` is the data directory.
- Code identifiers are in `monospace`. File paths are in `monospace`.
- "Must" gives a requirement. "Can" gives a permission. "Does" gives a fact about current behavior.
- A **Note** gives extra information. A **Caution** warns about a possible loss of data or a security effect.
