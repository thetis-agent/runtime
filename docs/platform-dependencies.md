# Platform boundary tools

CI coverage aggregation uses Ubuntu 24.04's `lcov` **2.0** package, installed only
in the final reporting job. Its `--add-tracefile` operation combines execution
counts for overlapping sources, with `--branch-coverage` enabled. The existing
bounded Node reporter validates the merged output and calculates summaries. LCOV
is not a runtime dependency and is not needed for local tests or single-run
coverage. Source: [Ubuntu's LCOV manual](https://manpages.ubuntu.com/manpages/noble/man1/lcov.1.html).

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

## Installation and release-verification tools (ADR 0048)

These are used by `install.sh` and by `thetis update`, never by package code and
never inside a sandbox. They are already installed; none was added by a package
installation or a lifecycle script, and none is a new npm dependency.

- `ssh-keygen` (OpenSSH_9.2p1 Debian-2+deb12u7, OpenSSL 3.0.17), `/usr/bin/ssh-keygen`, SHA-256 `7c8c19876367ac5ffeda31e3caf20241a96a44afc0bbe65dc55eae2bdf20c139`: verifies a release's `SHA256SUMS.sig` against the embedded `allowed_signers` file with `-Y verify -n zero-release`, and signs it at release time with `-Y sign`. Node's `crypto` can verify an ed25519 signature but not the OpenSSH signature container or its namespace and allowed-signers semantics, and re-implementing that container would be the trust root of the installer. Every host with OpenSSH already has this tool.
- `sha256sum` (GNU coreutils 9.1), `/usr/bin/sha256sum`, SHA-256 `6cd7c6bfc81d645ba13b927e31651a1466092a28ed0bd2632e82f8b27882b25e`: checks the signed `SHA256SUMS` manifest with `--check --strict`, so the manifest a person can read is the manifest the installer enforces.
- `dash` 0.5.12-2 as `/bin/sh`, SHA-256 `f5adb8bf0100ed0f8c7782ca5f92814e9229525a4b4e0d401cf3bea09ac960a6`: runs `install.sh`. The script is POSIX `sh` with no `pipefail`, so every pipe writes to a file and checks its status. `lib/sandbox-runner/index.ts` already requires this shell.
- `git` 2.39.5, `/usr/bin/git`, SHA-256 `00c84136d8294294580daa32f25b3e83ddb8341e9b5b70722e4c9a973ba5f749`: already required by `lib/registry/git.ts`; the installer additionally runs `init --bare`, `bundle verify`, `bundle unbundle` and `update-ref` to reconstruct the deployment's registry from the release's offline bundle.
- `systemd` 252 (252.39-1~deb12u1) with `systemd-creds`, `/usr/bin/systemd-creds`, SHA-256 `79c716b88d2ffcc618e64de66e84b8a3a887708ee8b445368530f1d8d28bab0d`: systemd 252 is the floor because `LoadCredential=` delivers the master key as a descriptor the service opens; `systemd-creds encrypt --with-key=tpm2` is used only for `--key-store tpm2`, and only when `systemd-creds has-tpm2` succeeds.
- `fallocate` (util-linux 2.38.1), `/usr/bin/fallocate`, SHA-256 `35888f0737e3a10c4cca703d094acc71e636f324b26ddc140c9a05f4bc47bc65`, and `mkfs.ext4` (mke2fs 1.47.0), `/usr/sbin/mkfs.ext4`, SHA-256 `86706a8f295ffc70ff52d2510decc49c15e91144622b17d02916e50d37187c7c`: provision the one bounded state volume so its enforced capacity equals every declared `maximumBytes`, which is what `lib/sandbox-runner/index.ts` compares against `statfs`. `--no-mount` skips both and checks an existing mountpoint's capacity instead. Both run once, as root, and are printed by `--dry-run` before they run.
- `tar` and `gzip` (versions above) are reused by the installer to extract the release archive; `flock` and `cat` (above) are reused unchanged by the supervisor's deployment lock.

OpenSSH tools call `getpwuid(getuid())` unconditionally near the start of
`main()` and fatal with "No user exists for uid <uid>" if that lookup fails, so
any bubblewrap namespace that unshares the user namespace and provides no
`/etc/passwd` entry for the mapped uid — the bare `--dir /etc` in
`lib/sandbox-runner/namespace.ts` — cannot run `ssh-keygen` in any mode
(`-t`, `-Y sign`, `-Y verify`), whatever flags it is given. `scripts/test.ts`
therefore mounts a one-line synthetic passwd file read-only at `/etc/passwd`
inside the **test** namespace only. Deployment and package sandboxes keep an
empty `/etc` and gain no account data; release verification runs on the host,
outside every sandbox.
