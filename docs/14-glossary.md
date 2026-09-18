# 14 Glossary

| Term | Definition |
|---|---|
| **Agent** | The process `@thetis/userspace-agent` that runs inside a fence. It runs package code for the kernel. Not to be confused with a subagent. |
| **Built-in call** | The provider call step that the kernel runs itself. Reference `{ package: "@thetis/kernel", export: "provider-call" }`. |
| **Call** | The variable `call`. The parameterized request to a provider: model, system prompt, messages, tools, params. |
| **Composition root** | The function `createKernel`. The only place that constructs kernel services. |
| **Container** | The class `Container`. Maps tokens to lazily created singletons. |
| **Conversation** | The variable `conversation`. The full message history of a session. |
| **Data directory** | `$THETIS_HOME`. Holds the config, the store, the journal, the promoted packages, the shared directory, and the userspaces. |
| **Declaration** | One entry of `thetis.config` in a manifest: `{ type, secret?, required?, default?, scope?, help? }`. What a package says about a key it reads. |
| **Driver** | A package of type `storage` that implements `StoreDriver`. Chosen by `storage.driver`, loaded by the host, never installed into a fence. `@thetis/store-toml` is the default. |
| **Enumerator** | The component that produces the step list for a turn. The default is kernel code. A package can replace it. |
| **Fence** | The boundary around one userspace. Also the interface `Fence` and its implementation `ProcessFence`. |
| **Fence pool** | The class `FencePool` in `@thetis/sandbox`. One open fence per userspace. The kernel sees it as the interface `Fences`. |
| **Gateway** | A package that exposes an endpoint. It uses the session API only. |
| **Harness** | The variable `harness`. Per-session state that packages own. Also, broadly, the prompt, tools, memory, and subagents around the model. |
| **Home** | The directory `<userspace>/home`. The working directory of tools and steps. |
| **Kernel** | The package `@thetis/kernel`. The part of the trusted service plane that decides who may do what. `@thetis/host` wires it; `@thetis/sandbox` builds its fences; `@thetis/lib` holds its mechanism; `@thetis/contracts` holds its types. |
| **Kernel client** | The object `env.kernel` inside a fence. Its methods become RPC calls to the kernel. |
| **Layer** | One of the four sources of a package's configuration, merged in order: `default`, `file`, `system`, `user`. A later layer wins a key. |
| **Manifest** | The `package.json` of a package, including the `thetis` field. |
| **Message** | One entry of a conversation: `{ role, content, toolCalls?, toolCallId?, name? }`. |
| **Package** | A directory with a manifest. The unit of everything that is not the kernel. |
| **Package query** | The object `ctx.packages` inside a step: `has`, `get`, `list`. |
| **Phase** | A named position in the pipeline. Steps declare the phase they belong to. |
| **Pipeline** | The ordered list of steps for one turn. |
| **Plan** | The output of the enumerator. An array of step references. |
| **Provider** | A package that sources models. It implements `models()` and `call()`. |
| **Provider registry** | The class `ProviderRegistry`. Finds a provider for a model id. |
| **Registry** | The store namespace `registry`. Records which packages exist and where they are installed. |
| **RPC** | A request from a fence to the kernel. Carried on the same protocol as operations. |
| **Scope** | The `@name` prefix of a package name. `@thetis` is the system. `@<user>` is that user. |
| **Service plane** | The host process that runs the kernel. No package code runs there. |
| **Session** | One conversation with its harness state. Belongs to one user. |
| **Session API** | The class `SessionApi`: `create`, `send`, `ask`, `inspect`, `list`. |
| **Step** | A function a package exports and declares under `thetis.steps`. Receives the context, returns mutations. |
| **Step reference** | `{ package, export, id?, phase? }`. An entry of the plan. |
| **Step result** | `{ conversation?, call?, harness? }`. The mutations a step returns. |
| **Store** | Two things. The directory `<userspace>/store`, which holds package links and git clones (`env.store`). And the service plane's document store, `$THETIS_HOME/store` with the default driver, which holds the records, the configuration layers and what packages keep through `env.storage()`. See [26-storage.md](26-storage.md). |
| **Subagent** | A session whose `parent` is another session of the same user. |
| **System package** | A package in scope `@thetis`. Shipped in `<root>/packages`. |
| **System userspace** | The userspace of the user `_system`. Runs system providers. |
| **Token** | A typed key of the container. The table `T` lists all kernel tokens. |
| **Tool** | A function a package exports and declares under `thetis.tools`. The model calls it by name. |
| **Tool spec** | `{ name, description, parameters, package, export }`. An entry of `call.tools`. |
| **Turn** | One pass through the pipeline of a session. |
| **Turn event** | One item of the stream that `sessions.send` returns. |
| **User** | An identity with an id, a role, and a status. |
| **Userspace** | The fenced directory and process environment of one user. |
| **Variables** | `conversation`, `call`, and `harness`. What every step sees and can change. |
