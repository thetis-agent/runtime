# 08 · Vocabulary

The words the successor shows people. Each maps to a mechanism; the
mechanism's name never appears in the UI. Requirement R9.

| Say | Never say | It means |
| --- | --- | --- |
| **Kernel** | host, orchestrator, daemon, server | the one trusted process: who you are, the fence, the secrets, which sockets a run sees, and the act of changing the default. "Thetis's kernel" means the old 61,000-line binary |
| **Environment** | worktree, checkout, profile install, container | your own copy of the system, where your agent can change anything, and the only place it can |
| **Sandbox** | runner, namespace, jail, VM | the fence the kernel puts around an environment; it decides what files, limits and network exist inside |
| **Package** | module, aspect, guest, component, crate | something you can add, remove or swap: a set of tools, skills, a surface, a helper process |
| **Surface** | gateway, connector, frontend, bot | a way to talk to the agent: the web page, Discord, the game |
| **Provider** | backend, API, endpoint, vendor adapter | where the model runs: a hosted service or a local server; swappable |
| **Marketplace** | package index, npm | the registries the deployment trusts, taken together |
| **Registry** | remote, repo, upstream | one git repository that holds packages; the deployment has its own, and can add others by URL |
| **Version** | revision, snapshot, commit, tag | a numbered, unchangeable state of a package |
| **Fix**, **improvement**, **new feature** | patch, minor, major, semver | what a new version is; the number says which |
| **Requires** | depends on, peer dependency, imports | what a package needs, by name: another package, a service, a setting, a secret, a capability |
| **Provides** | exports, exposes, registers | what a package supplies, by name and version |
| **Service name** | protocol, interface | the name a requirement and a provider match on, such as `service/vector-store` |
| **Contract** | interface definition, spec, schema package, WIT | a package that says what a name means: its messages, their shape, and the test a provider must pass |
| **Secret** | credential, key, token | a value only the kernel holds, yours, a project's, or the company's; a service that needs one gets it at start and never sees it on disk |
| **Capability** | hardware, feature flag | a fact about the machine the kernel reports, such as a GPU |
| **Working on** | linked, checked out, in work, branch | a package your agent is changing in your environment |
| **Try** | build, hot swap, reload | it is running in your environment now |
| **Publish** | push, release, open a PR | put a version in the marketplace for review |
| **Review** | code review, approve | read what changed, the checks and the scores, and what it requires |
| **Make default** | merge, adopt, promote, pin, land | make a version what everyone gets |
| **Default** | shared profile, trunk, main, master | the set of versions everyone runs unless they choose otherwise |
| **Undo** | revert, rollback | make the previous version the default again |
| **Update** | pull, sync, re-resolve | bring the latest defaults into your environment |
| **Send back** | request changes | a reviewer's note that lands in your environment for your agent to act on |
| **Space** | workspace, root, mount, volume | a folder agents work in: the company's, a project's, or yours |
| **Project** | team, group, org | a named space with members |
| **Artifact** | output, attachment, blob, revision | a file an agent made for you, kept in a space and linked from the conversation |
| **Stage** | middleware, plugin, hook, transformer, operator | a function a package adds to the turn: it sees an event and can change it or add to it |
| **Runtime** | provider, backend, engine, retriever | a stage that replaces the default for one event, such as finding skills |
| **Service** | sidecar, daemon, subprocess | a helper program a package runs, for you alone or once for everyone |
| **Conversation** | session, thread | one exchange with the agent |
| **Skill** | prompt, instruction set | a named set of instructions the agent can be given |
| **Check** | type check, smoke test, eval, CI | what a version passes before it can become default |
| **Score** | metric, benchmark | one of the five numbers, attached to a version |

## Sentences the UI uses

- "This is running in your environment. Publish it when you want it reviewed."
- "*Context panel 2.2.0* requires *Search index 0.2.0*, which is not the
  default yet. Making it default brings both."
- "Making *Context panel 2.1.1* default changes three scores: cost per task
  −2%, pass rate unchanged, edit to serve unchanged."
- "*Context panel 2.2.0* is now the default. Update your environment to get
  it, or keep working on your copy."
- "Undo *Context panel 2.2.0*? Everyone goes back to 2.1.1."
