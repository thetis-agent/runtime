# Decisions taken

- 2026-09-09: Use installed Node 24.18.0 for direct TypeScript execution; the shell's Node 18 is unsuitable (ADR 0002).
- 2026-09-09: Bootstrap development dependencies with npm and `--ignore-scripts`; publish only registry-contained dependency closures, never external runtime dependencies (implementation prompt; proposal §5).
- 2026-09-09: Treat the design exercises as historical reasoning wherever the final schemas, suites or later ADRs override them; preserve accepted records unchanged (ADR 0001).
- 2026-09-09: Stop before claiming child descriptor isolation: a real sandboxed reproduction forwards a close-on-exec kernel-like socket to a child; leave the guarantee decision Proposed in ADR 0021 (TE-024).

- 2026-09-09: The operator accepted ADR 0021: ordinary children inherit no authority; deliberate delegation shares the original run principal and fencing. TE-024 is clarified accordingly; implementation resumed.
