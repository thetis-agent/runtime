# Runtime module: door

The reverse proxy on the one host port. It runs in the host process; `thetis serve` starts it. It copies bytes between the browser and unix sockets it never authenticates against: `/login`, `/logout`, and `/` go to the login target, `/<person>/...` goes to that person's own gateway. A path prefix is routing, never authority; each gateway rechecks the cookie with the kernel, which answers a fence only about its own user.

## What it provides

Nothing in `thetis`. Not installable: a library the command line uses. It depends on nothing from `@thetis`.

One export, `createDoor(options)`, returns a `node:http` server. The options are `loginSocket`, the unix socket of the login target; `socketFor(user)`, the unix socket of a person's gateway or `undefined` when there is no such person; and an optional `log`.

| Path | Where it goes |
|---|---|
| `/`, `/login`, `/login/...`, `/logout` | `loginSocket`. |
| `/<user>` | `303` to `/<user>/`. |
| `/<user>/...` | `socketFor(user)`, when `user` matches `^[a-z][a-z0-9-]{0,31}$` and the function returns a path. |
| Anything else | `404`, "There is nobody here by that name." |

A socket file that does not exist answers `503`; an upstream that fails to answer, `502`. Hop-by-hop headers are dropped in both directions. The server has no request timeout, so an event stream through it runs as long as the gateway keeps it open; `close()` closes every open connection itself, and each closed response tears down its upstream request.

## Configuration

`config.door` has `host` (default `127.0.0.1`) and `port` (default `8777`). `thetis serve` binds the door there. `host: "0.0.0.0"` exposes the door to the network; the login cookie then travels in clear text over HTTP unless a TLS terminator sits in front, with `secure` set on `@thetis/gateway-login`.

## Use

`thetis serve` opens the door in front of the login target of the system userspace and the `web.sock` of every person:

```ts
import { createDoor } from "@thetis/runtime/door";

const door = createDoor({
  loginSocket: resolve(kernel.userspaces.pathFor("_system").run, "login.sock"),
  socketFor: (user) => {
    const record = kernel.users.get(user);
    if (!record || record.role === "system" || !kernel.userspaces.exists(user)) return undefined;
    return resolve(kernel.userspaces.pathFor(user).run, "web.sock");
  },
  log,
});
await new Promise<void>((done, fail) => door.once("error", fail).listen(config.door.port, config.door.host, done));
```

Then open `http://127.0.0.1:8777/login` in a browser.

## Files

| File | Content |
|---|---|
| `index.ts` | `createDoor`, `DoorOptions`: the routing, the forwarding, and the close that ends open streams. |

## Tests

`npm test` from the runtime root builds and runs every suite. The suite of this package is `test/door/door.test.ts`: closing the door ends an open event stream and its upstream request. To run it alone after `npm run build`: `node --test dist/test/door/door.test.js`. `packages/gateway-web/test/gateway.test.ts` runs every case through a door in front of the login target and one gateway per person.
