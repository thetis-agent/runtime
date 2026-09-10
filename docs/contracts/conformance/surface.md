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
