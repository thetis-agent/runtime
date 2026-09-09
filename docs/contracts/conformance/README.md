# Conformance suites

One suite per contract. Each test has an id, a subject (who is under
test: a provider of a name, a handler, the core, or the kernel), a
given, a when, and a then. A suite runs in the clean kernel environment
at publish (ADR 0004 §3) against the published commit, with the mock
provider and the faux gateway from `test/`. A test that needs a model
uses the mock; none uses a judge. The subject never ships its own
suite: the suite is the contract package's (ADR 0006 §2).

Ids are stable: a test is never renumbered, only retired. A retired
test stays listed with its reason.
