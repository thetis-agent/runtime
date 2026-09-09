# Decisions taken

- 2026-09-09: Use installed Node 24.18.0 for direct TypeScript execution; the shell's Node 18 is unsuitable (ADR 0002).
- 2026-09-09: Bootstrap development dependencies with npm and `--ignore-scripts`; publish only registry-contained dependency closures, never external runtime dependencies (implementation prompt; proposal §5).
- 2026-09-09: Treat the design exercises as historical reasoning wherever the final schemas, suites or later ADRs override them; preserve accepted records unchanged (ADR 0001).
- 2026-09-09: Stop before claiming child descriptor isolation: a real sandboxed reproduction forwards a close-on-exec kernel-like socket to a child; leave the guarantee decision Proposed in ADR 0021 (TE-024).

- 2026-09-09: The operator accepted ADR 0021: ordinary children inherit no authority; deliberate delegation shares the original run principal and fencing. TE-024 is clarified accordingly; implementation resumed.
- 2026-09-09: Finalize spill files with an atomic hard-link creation followed by temporary-name removal, so a repeated call id cannot overwrite an existing artifact (TE-016).
- 2026-09-09: Settle and acknowledge final usage before yielding stop so a client that closes at stop cannot suppress attribution; the same final counters remain observable after stop (PR-011).
- 2026-09-09: TE-001 permits no retrieve handler, so the base loop has an empty fallback and does not require a stage/retrieve provider; this also avoids a core–retriever requirement cycle.
- 2026-09-09: ADR 0022 restricts ephemeral context appends to harness/history; system/skills remain immutable prefix-owned sections, preserving TE-009 and TE-011.
- 2026-09-09: Keep universal and activated skill entries present without `body` when the body budget is exhausted; retain their description as an ignored extension, satisfying SK-010 and TE-008 without exceeding TE-005.
- 2026-09-09: Resolve file symlinks to the destination grant; a read may cross from rw to ro but a write may not, and dangling links are refused (TE-019).
- 2026-09-09: ADR 0023 restores a fenced generation's pins and snapshot under a fresh number; rollback never revives old or failed-candidate credentials.
- 2026-09-09: ADR 0024 supplies schema-defined assistant tool-call history through provider and turn-events contract 1.1.0; the copied 1.0 schemas remain the historical baseline.
- 2026-09-09: Compaction retains an assistant call and its tool results as a group whenever either survives; history limits remain a projection and cannot strand a tool result (ADR 0024).
- 2026-09-09: The provider socket uses a separate schema-defined `{v, runToken}` prelude before describe or one request stream; credentials never enter model.begin, conversation history or vendor requests. The design requires token presentation but leaves its framing unspecified.
- 2026-09-09: A writable grant requires filesystem capacity no larger than its declared storage budget; the runner refuses ordinary unbounded directories. Fixed-size volumes or bounded filesystems supply the quota without filesystem-specific kernel logic (ADR 0005 §4).
- 2026-09-09: The test supervisor receives delegated cgroup controls and writable private procfs to launch real nested sandboxes; candidate processes receive neither those controls nor writable procfs (TE-024).
