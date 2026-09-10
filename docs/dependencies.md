# Dependencies

Development bootstrap uses npm with `--ignore-scripts`; runtime package delivery remains the deployment's git registry (proposal §5). No published package may declare an external dependency. The root lock records the entire bootstrap dependency closure; shared libraries must enter the deployment registry with their dependency closure before publication.

ADR 0037 adds no external dependency. Node **24.18.0**, executable SHA-256
`41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c`, supplies
`node:stripTypeScriptTypes` in strip-only mode and synchronous `registerHooks`.
Each artifact records the exact Node version and both content hashes. The already
pinned Ajv **8.17.1** also generates standalone committed guards; dynamic schemas
retain its runtime compiler. `package-lock.json` includes the internal
`lib/artifacts` workspace and is updated with `--ignore-scripts --offline`.

| Library | Exact version | Purpose and standard-library gap | Integrity |
| --- | --- | --- | --- |
| ajv | 8.17.1 | Validate JSON Schema draft 2020-12; Node has no JSON Schema validator. | sha512-B/gBuNg5SiMTrPkC+A2+cW0RszwxYmn6VYxB/inlBStS5nx6xHIt/ehKRhIMhqusl7a8LjQoZnjCs5vhwxOQ1g== |
| semver | 7.7.2 | Match semantic version ranges, explicitly required by the implementation prompt; Node has no range matcher. | sha512-RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA== |
| ws | 8.21.3 | Serve RFC6455 WebSockets for the gateway wire; Node has a WebSocket client but no server parser. Version includes upstream fixes for GHSA-58qx-3vcg-4xpx and GHSA-96hv-2xvq-fx4p; framing is bounded in lib/websocket. | sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw== |
| yaml | 2.8.1 | Parse standard skill frontmatter; Node has no YAML parser. | sha512-lcYcMxX2PO9XMGvAJkJ3OsNMw+/7FKes7/hgerGUYWIoWu5j/+YQqcZr5JnPZWzOsEBgMbSbiSTn/dv/69Mkpw== |
| fast-deep-equal | 3.1.3 | Ajv equality checks; Node has no JSON Schema equality implementation with this interface. | sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q== |
| fast-uri | 3.1.7 | Ajv URI and schema-reference resolution; Node URL does not implement this JSON Schema resolver interface. | sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg== |
| json-schema-traverse | 1.0.0 | Ajv schema traversal; Node has no JSON Schema traversal API. | sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug== |
| require-from-string | 2.0.2 | Ajv generated-validator loading; Node has no compatible packaged loader interface. | sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw== |

The Linux runtime also uses these already-installed system tools. They are
outside the npm package closure; the hashes below identify this deployment's
executables. Packages still declare no direct dependency on them.

| Tool | Exact version | Purpose and standard-library gap | Integrity |
| --- | --- | --- | --- |
| bubblewrap | 0.8.0 | Mandatory Linux namespace and mount boundary; Node exposes no equivalent namespace setup API. | sha256:85580dd52ed366ece8844e90fa75ac7c4de8802963071344e123221fb9f6f11e |
| systemd-run | 252.39-1~deb12u1 | Obtain an isolated delegated cgroup scope for the supervisor and tests; Node exposes no service-manager delegation API. | sha256:0c9d7a06179fe9061ced7341e2cd2f82931ce6ae0dec91111d8e581f03f1761c |
| dash | 0.5.12-2 | Hold the launch gate before exec so cgroup attachment precedes every unprivileged instruction; child_process has no pre-exec hook. | sha256:f5adb8bf0100ed0f8c7782ca5f92814e9229525a4b4e0d401cf3bea09ac960a6 |

- Platform `slirp4netns` **1.2.0**, SHA-256 `22b1e7d763a4382b3fe5bf58f1d9ee95b7f8241e9b0f022236eaea2b25bd0533`: supplies userspace egress for a private network namespace; Node cannot configure a TAP interface or implement this network stack (ADR 0029).
- Platform `unshare` (util-linux) **2.38.1**, SHA-256 `9fb85770a4a0b5cb2bff8e64c2934dd1b0674eaaae18fd550dea2520c69a45d9`: creates the egress namespace before bubblewrap disables nested user namespaces; Node has no namespace-creation API (ADR 0029).
- Optional operator tooling: CPython **3.11.2**, `/usr/bin/python3.11`, SHA-256 `a83c0370d91532c96d4060a0e7c107d1f2889dad8a98e03395e86ef0373fd467`. The paid live launcher uses its standard-library `tomllib` to read the existing operator configuration without adding a runtime TOML dependency; Node has no built-in TOML parser. It is already installed and is not required by packages, the kernel or the offline suite.

The WebSocket pin was checked against the upstream [memory disclosure advisory](https://github.com/websockets/ws/security/advisories/GHSA-58qx-3vcg-4xpx) and [fragment exhaustion advisory](https://github.com/websockets/ws/security/advisories/GHSA-96hv-2xvq-fx4p). Bootstrap development types: `@types/ws` 8.18.1, `sha512-ThVF6DCVhA8kUGy+aazFQ4kXQ7E1Ty7A3ypFOe0IcJV8O/M511G99AW24irKrW56Wt44yG9+ij8FaqoBGkuBXg==`.
