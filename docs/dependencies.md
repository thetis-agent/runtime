# Dependencies

Development bootstrap uses npm with `--ignore-scripts`; runtime package delivery remains the deployment's git registry (proposal §5). No published package may declare an external dependency. The root lock records the entire bootstrap dependency closure; shared libraries must enter the deployment registry with their dependency closure before publication.

| Library | Exact version | Purpose and standard-library gap | Integrity |
| --- | --- | --- | --- |
| ajv | 8.17.1 | Validate JSON Schema draft 2020-12; Node has no JSON Schema validator. | sha512-B/gBuNg5SiMTrPkC+A2+cW0RszwxYmn6VYxB/inlBStS5nx6xHIt/ehKRhIMhqusl7a8LjQoZnjCs5vhwxOQ1g== |
| semver | 7.7.2 | Match semantic version ranges, explicitly required by the implementation prompt; Node has no range matcher. | sha512-RF0Fw+rO5AMf9MAyaRXI4AV0Ulj5lMHqVxxdSgiVbixSCXoEmmX/jk0CuJw4+3SqroYO9VoUh+HcuJivvtJemA== |
| yaml | 2.8.1 | Parse standard skill frontmatter; Node has no YAML parser. | sha512-lcYcMxX2PO9XMGvAJkJ3OsNMw+/7FKes7/hgerGUYWIoWu5j/+YQqcZr5JnPZWzOsEBgMbSbiSTn/dv/69Mkpw== |
| fast-deep-equal | 3.1.3 | Ajv equality checks; Node has no JSON Schema equality implementation with this interface. | sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q== |
| fast-uri | 3.1.7 | Ajv URI and schema-reference resolution; Node URL does not implement this JSON Schema resolver interface. | sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg== |
| json-schema-traverse | 1.0.0 | Ajv schema traversal; Node has no JSON Schema traversal API. | sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug== |
| require-from-string | 2.0.2 | Ajv generated-validator loading; Node has no compatible packaged loader interface. | sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw== |
