# Paid tool API connections

A tool package can call a hosted API from its registered process. The package
owns the API fields and response handling. The kernel retains identity, secrets,
network grants, and generation control. This uses the existing service path in
ADR 0019 and cost rules in ADR 0020.

The package loader supplies `ctx.callService(name, request, signal?)` at `init`.
The name must be a static service requirement or provision in the package
manifest. `setup.provided[name].endpoint` supplies the mounted Unix socket.
The helper adds the inherited run token. The stage does not receive that token
through this helper. Shutdown closes all active connections. Failed initialization
also closes them.

The optional third argument to `Stage.call` is an `AbortSignal`. The dispatcher
aborts this signal when the call finishes or reaches its deadline. A stage must
pass it to external work. Closing a connection stops local work. A vendor can
continue remote work; the package must supply an explicit cancel operation when
its API requires one.

Use `contract/tool-service` for the request and response frames. Use
`lib/service/tool-server.ts` with the existing service lifecycle. This helper
checks the frame and reply ID. It cancels work on a disconnect or second request.
The inherited service factory also receives its own run token as its fifth
argument. Keep this evidence inside the registered process.

A paid process can use `PaidTools` from `lib/provider/tool-call.ts`. The process
must construct `KernelAuthority` with its service ID. This checks the caller's
service grant before admission. Tool policy and cost checks precede API access.
The complete maximum cost is reserved and stored before execution. The process
reports and stores that cost before it returns the answer. It keeps this charge
if external work might have started, including a timeout or vendor error.
An accounting failure prevents subsequent calls. `reservedCost` is this local
charge, not a vendor invoice.

The client permits eight active calls per package. Its maximum deadline is
120,000 ms, including connection setup. The service lifecycle retains its
existing connection, frame, probe, and drain limits. API packages must also bound
HTTP requests, responses, concurrency, and persisted state. They must discard
raw vendor errors and keep secret values out of results and logs.

Select `contract/tool-service` for both the tool stage and API process. Select
`lib/service`, `lib/provider`, and their normal runtime dependencies. A deployment
must declare the service target, grant it to each caller, and mount its socket.
Adding the package to a profile alone does not start or grant its process.

| Test ID | Required behavior |
| --- | --- |
| TS-001 | Transfer the call and inherited evidence through the tool wire. |
| TS-002 | Reject invalid replies and mismatched call IDs. |
| TS-003 | Close the socket and cancel local work at the deadline or shutdown. |
| TS-004 | Refuse undeclared or unmounted service names. |
| TS-005 | Check identity, mode, and trusted cost limits before API access. |
| TS-006 | Store admission before API access and settlement before the answer. |
| TS-007 | Refuse further work after accounting fails. |
| TS-008 | Exercise the registered process with real isolation and secret delivery. |

The wire and accounting tests are in `lib/service/tool.test.ts` and
`lib/provider/tool-call.test.ts`. API packages use `test/paid-service.ts` for
TS-008. That fixture does not simulate the kernel or the sandbox.
