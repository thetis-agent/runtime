# Platform boundary tools

Release-only archive tooling: GNU tar **1.34**, `/usr/bin/tar`, SHA-256
`4e11647a9c86fb8857768bd622c43ed0662d7019f60f5bdd12fb15ac5f087070`, and
gzip **1.12**, `/usr/bin/gzip`, SHA-256
`953d326212574b5ad3cbe5f87034b0c142b6e6d71bb619c51eaa3d2ce47f7e24`,
are the already-installed versions used to validate `scripts/distribution.ts`
locally. Node has no standard tar encoder; GNU tar provides stable ordering,
timestamps and ownership without another JavaScript dependency. CI records its
distribution-provided tool versions and hashes in each delivery's `platform.txt`.
These tools assemble delivery archives; they do not replace registry extraction
or kernel hash verification.

- `flock` (util-linux) 2.38.1, `/usr/bin/flock`, SHA-256 `09f189297bce1f713e2ba9a8607a89f17902edadc54d3c3162d43f76e8d3b6f9`, and `cat` (coreutils) 9.1, `/usr/bin/cat`, SHA-256 `008f819498fe591f3cc920d543709347d8d14a139bb3482bc2cd8635c1b3162e`: hold an exclusive advisory deployment lock tied to the supervisor's pipe. Node has no standard-library `flock` API; the bounded helper receives no key or token. Both tools were already installed.

- `slirp4netns` 1.2.0 (libslirp 4.7.0), `/usr/bin/slirp4netns`, SHA-256 `22b1e7d763a4382b3fe5bf58f1d9ee95b7f8241e9b0f022236eaea2b25bd0533`: configures unprivileged outbound traffic for the mandatory private network namespace (ADR 0029). Node's standard library cannot configure a TAP network or provide the required userspace network stack. This is the installed deployment tool; no package installation or lifecycle script was run.
- `unshare` (util-linux) 2.38.1, `/usr/bin/unshare`, SHA-256 `9fb85770a4a0b5cb2bff8e64c2934dd1b0674eaaae18fd550dea2520c69a45d9`: creates a private network namespace before bubblewrap's final user namespace disables further namespace creation. Package code still starts only after bubblewrap. Node has no namespace-creation API.
