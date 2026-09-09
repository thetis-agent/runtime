# Implementation status · 2026-09-09

Milestone A is **in progress**. The operator accepted ADR 0021's run-principal
boundary and authorized continuation. Ordinary child spawning must not
inherit authority; deliberate delegation remains confined to the original
run and is invalidated by generation fencing.

Prepared:

- `AGENTS.md`, written before code and under 60 lines.
- The requested complete design copy, read before implementation.
- Strict TypeScript and the requested ESLint configuration.
- Four copied contract schemas and generated committed-source types,
  with a stale-generation check and shared entry validation.
- Initial bounded NDJSON codec, budget helper, scripted provider mock,
  faux gateway and clock edge. These are incomplete foundations, not
  completed contract implementations.
- A bubblewrap test launcher and a real-socket reproduction that checks
  close-on-exec before demonstrating explicit forwarding to a child.

Validation of the current foundation:

- Node 24.18.0 is installed at
  `/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node`; shell Node is 18.20.4.
- Bubblewrap user, process and network namespace probing succeeds
  outside the agent tool sandbox.
- A user systemd scope accepts `MemoryMax=512M`, `TasksMax=64` and
  `CPUQuota=100%`; these bound the development test run.
- Eight foundation tests pass inside bubblewrap, including TE-024 ordinary
  spawning, evidence designation, unknown bindings, token expiry and
  deliberate delegation constrained by person and generation.
- Strict type checking and lint pass with no warnings.

No full conformance run, UI chat, OpenRouter turn, default-profile pins,
cache-hit acceptance measurement, edit-to-serve measurement or idle-RSS
measurement has been completed. The generation machine, kernel, complete
packages and compatibility matrix remain to be implemented. No
`milestone-a.md` completion report is written because its prerequisite
has not been met.

Reproduce the current checks from `/opt/zero`:

```sh
/home/bitmuse/.nvm/versions/node/v24.18.0/bin/node scripts/check.ts
systemd-run --user --scope --quiet -p MemoryMax=512M -p TasksMax=64 -p CPUQuota=100% /home/bitmuse/.nvm/versions/node/v24.18.0/bin/node /opt/zero/scripts/test.ts
```

The agent tool sandbox blocks namespace setup; the second command needs
to run outside it. Tests themselves still run in bubblewrap. ADR 0021 is resolved; implementation has resumed.
