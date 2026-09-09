# ADR 0009 · Secrets have a scope, and the door resolves them by caller

**Status:** Accepted · 2026-09-09
**Deciders:** the operator; this session
**Amends:** ADR 0004 §5 (the model and key for bench runs), ADR 0007 §5 pin surface unaffected
**Supersedes:** nothing; the seventh draft had one deployment-wide `secret/llm` and no other case

## Context

The operator asked whether one person's environment can use a different
provider key from the deployment's default. The draft had a single
`secret/llm` held by the host and used by the `llm` door for every
caller. A person with their own key, a project with its own budget, and
a sponsor who wants some roles to bring their own key all had no path.

The pieces exist: spaces already have three scopes, every run carries a
per-run token that names the person, and `secret/` is already a name
only the host satisfies.

## Decision

1. **A secret has a scope:** `deployment`, `project/<name>`, or
   `person/<user>`. The host stores secrets in its own store, encrypted
   at rest, keyed by scope and name. No secret is ever in a profile, a
   space, an environment, or a conversation.
2. **The door resolves by caller.** A call on the host socket carries
   the per-run token, which names the person and the conversation's
   project. For `secret/<name>` the door takes the first of
   `person/<user>`, `project/<name>`, `deployment`. The same order
   applies when the host delivers a secret to a `person`-scope spawn.
   A `deployment`-scope service receives only `deployment` secrets.
3. **No silent fallback.** If a person-scoped key fails (rejected,
   exhausted, rate-limited), the turn fails with that reason written
   into the conversation. It does not fall through to the project's or
   the deployment's key. Falling through would let a person spend
   someone else's budget by breaking their own key.
4. **Policy per role in `auth`:** a role may use the deployment key,
   must bring its own, or may use either. A sponsor that opens the
   product to many people sets `own-only` for the public role and pays
   only for the roles it chooses.
5. **A person sets their own secrets through a host page or the CLI**,
   never through the agent. A stage cannot read, set, or list a secret;
   the agent learns only that a name resolved or did not.
6. **Bench runs use the deployment key only**, and the model the host
   pins, regardless of the publisher's secrets. A person cannot run the
   suite on their own key, and the suite cannot depend on a person's
   key existing.
7. **The turn log records the scope that resolved**, never the value:
   `secret_scope: person | project | deployment`. Spend is attributed
   to the person as before; whose money it was is the scope column.

## Alternatives considered

**Per-person keys as settings in the environment.** Lost: a setting is
readable by the person's own rewritable stages, and the rule that a
secret never enters an environment is what makes the sandbox story
hold.

**Fallback to the deployment key on failure.** Lost, as above; a
failure is a message, and the person fixes their key.

**Only deployment and person scopes.** Considered; project scope costs
one more line in the resolution order and matches spaces, and a
project with its own budget is the ordinary company case.

## Consequences

Good: one person on their own key, a project on its own budget, a
public role that must bring its own key, all with the same three-line
resolution; the door and the metering do not change shape.

Bad: the host gains a secret store with encryption at rest and a page
to manage it; a person whose key breaks sees failures rather than
service until they fix it, which is the intended trade.

## Revisit

If a deployment needs per-person keys for a service it does not
control (an MCP server's token), the same scope rule applies to that
secret and this record covers it; if it needs a secret per
conversation, that is a new scope and a new record.
