# Surface conformance

The subject is a package that contributes to a surface: it requires
`contract/surface` and provides `panel/<id>`, `renderer/<kind>`, or both. Its
contribution is the `surface` block of its own `package.json`, read by the
surface that serves it. These tests exercise that block against the schema; a
provider's served assets and its registration behaviour are the serving
surface's own tests, in the package repository.

| ID | Given, when, then |
| --- | --- |
| SF-001 | A block declaring a panel and a renderer: validate; it matches `#/$defs/surface`, and a block declaring neither is still valid, so a package may contribute one kind without the other. |
| SF-002 | An entry path outside `/surface/`, or one that escapes its own segment: validate; refused, so one package can never claim another's served path. |
| SF-003 | A panel whose id is not a lowercase name, whose label is empty or over 32 characters, or which omits its entry: validate; refused. |
| SF-004 | More panels or renderers than a surface will host: validate; refused at the declared ceiling rather than at serve time. |
| SF-005 | A block declaring commands, with and without panels beside them: validate; a declaration stands on its own, because the host reads it from the same block whether or not the package also draws rows (ADR 0051). |
| SF-006 | A command whose verb is not a lowercase name, whose label is empty or over 64 characters, which omits either, or whose role is not one the kernel knows: validate; refused, so a package's reach cannot be widened by a name nothing checks. |
| SF-007 | More commands than a surface will forward: validate; refused at the declared ceiling rather than at request time. |
