# Tool service contract 1.0

The schema in `contracts/tool-service/schema.json` is authoritative.

Send one UTF-8 NDJSON request per Unix socket connection:

```json
{"v":"1","runToken":"<inherited evidence>","call":{"id":"call-1","name":"lookup","args":{},"deadlineMs":30000,"mode":{"readOnly":true,"deny":[]},"roots":[],"budget":{"resultBytes":32768}}}
```

The service returns one `turn-events.callAnswer` with the same call ID. Unknown
fields are allowed. The receiver must ignore fields it does not use. A malformed
request closes the connection. A malformed response produces an `io` call error.

The request contains no caller-selected person or cost policy. Resolve identity
from the kernel. Verify the service grant before paid work. Do not send this
protocol to a vendor. The API adapter keeps vendor authentication inside the
registered process.

See [tool services](../tool-services.md) for lifecycle, limits, accounting, and
the TS-001–008 acceptance requirements.
