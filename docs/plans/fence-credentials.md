# Fence credentials and configuration lifetimes

Status: the first three parts are implemented. The rest is written down because it was decided, not
because it is done.

## What this is about

Two questions that looked separate and are not:

1. **What may a fence reach, and how is that decided?** The answer was a list of bubblewrap flags in a
   particular order, with the order's meaning in comments. Twice, a flag stopped doing anything and
   nothing said so.
2. **What does it take to change a setting?** The answer was a table in `25-restart.md`, maintained by
   hand, checked by nothing, and wrong in at least one row.

Both are the same failure: a rule that lives in prose beside the code instead of in the code. A credential
grant is where they meet, because a grant is configuration whose consumer is the fence.

## 1. The mount plan is data — done

`fencePlan` declares intents; `plan.ts` orders, validates and renders them. One rule orders them: **a
shallower target is mounted before a deeper one**, the only order in which every intent survives, because
a later mount can then be inside an earlier one and never over it. Equal depth keeps declaration order,
which is how a person's mount beats a read-only bind of the same path.

This was not an aesthetic change. `fence.hidden` masks `$THETIS_HOME`; the mask was written before the
read-only binds, and when the data directory moved under `/opt` the later `--ro-bind /opt /opt` landed on
top of it. Every fence could read the journal, the password file and every other userspace, and connect to
the control socket. No error, no failing test, the flag still in the command line. The cgroup destination
and `--unshare-cgroup` came apart the same way twice before that.

See [03-fence.md](../03-fence.md) section 3.6.

## 2. ssh: the agent holds the key, the fence holds the socket — done

A grant is `{ key, hosts? }`: one key **file**, never a directory, because a host `~/.ssh` is a bag of
unrelated credentials and granting the directory hands a fence all of them. The kernel reads the key and
loads it into an agent for that fence; what is bound in is the socket. The fence can ask for a signature
and can never ask for the key, the agent dies with the fence, and revoking is killing a process.

The alternative — binding a key directory read-only — differs in *blast radius over time*. A bound key is
copyable once and then valid for as long as the key is; an agent socket is usable only while the fence is
open, and every use is loggable.

See [03-fence.md](../03-fence.md) section 3.10.

## 3. Configuration lifetimes are declared — done

`CONFIG_TIERS` says, per key, what it takes to put a change into service, and `config.reload` derives its
behaviour from that. A key nobody declared is `boot`, the safe answer. The reload names the keys it could
not apply rather than looking like it worked.

See [25-restart.md](../25-restart.md) section 1.1.

## 4. Per-package authority — decided, not built

A grant is per **person**, because a fence is per person. Every package in a fence shares its agent, its
mounts, its Docker socket and — deliberately, and long before any of this — every other package's
configuration, secrets included (`config.effective` answers for any package in the same fence).

So per-package configuration is **organisation, not authority**, and saying otherwise would be the same
class of mistake as the mount plan: a rule asserted in prose that the code does not enforce. It is written
down in [12-security.md](../12-security.md) section 3 as a limitation rather than left to be inferred.

Real per-package authority needs a principal per package, which means **a fence per package**: the pool
keys on `(person, package)`, and services that today live in the person's single agent need rethinking.
That is the same direction as the microVM-per-userspace note in `03-fence.md`, and it is the only change
that would let a grant be narrowed.

**The futureproofing decision:** grants are shaped as `(package, capability)` from the start even though
the fence enforces at person granularity, so tightening enforcement later needs no migration of what is
already written down. The `SshGrant` contract is the first instance; a manifest-level `requires` block
declaring what a package needs — paths, credentials, Docker — is the next, mirroring `ConfigDecl`, which
already declares per-key metadata that the kernel centrally enforces.

## 5. Not done, and why

- **`requestTimeoutMs` is `boot`.** It is passed to each `ProcessHandle` as a number and captured there.
  Making it `fence` is a small change and was not made, so it is declared honestly instead.
- **`door` and `storage.driver` stay `boot`.** The door owns a bound listening socket; the right tool for
  changing it without a blip is systemd socket activation, not a configuration reload. Swapping a storage
  driver under a live kernel, mid-write, is not worth the machinery.
- **Brokering for gcloud.** The ssh agent is one instance of a general shape: the kernel holds the
  credential, the fence gets the *use* of it. The same applies to short-lived ADC tokens rather than a
  bound refresh token. Not built.
- **Per-fence generated keys.** For GitHub specifically, the least machinery is no host credential at all:
  generate a keypair per userspace, register the public half, and let each fence be its own machine. The
  agent is for keys that already exist and cannot move. Worth doing, not done.
- **The control socket authenticates nothing.** Reachability implies authority there: whoever can reach
  the path is an operator. The mask bug made it reachable from inside a fence; masking works again, so the
  hole is shut, and what is left is defence in depth against a future mount of the data directory.

  Two things that sound like the fix are not. The socket is already `srw-------`, so it is defended
  against *other users* — what it never defended against is a process running as the **same** user, and
  every fence is one, because the daemon and its fences all run as the unit's `User=`. And `SO_PEERCRED`,
  which would at least name the peer, is not exposed by Node's `net` at all; even if it were, it would
  report the fence's uid as the daemon's own and distinguish nothing. An earlier draft of this plan
  recommended it, and that recommendation was wrong.

  What would work is a token the daemon writes **outside the data directory** — under the host's `/run`,
  which no fence sees, because bubblewrap gives each one a fresh one — and which the command line presents
  on connect. That is implementable in plain Node.

  It is not built, deliberately. It changes the handshake every operator command depends on, including
  `thetis restart`, which is the way back if the handshake is wrong; the security benefit today is zero,
  since the mask already denies the path; and it is worth doing when someone decides it is, not as the
  tail end of an unrelated change.
