import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Mount, SshGrant, Userspace } from "../contracts/index.js";

/**
 * The on-disk layout of each user's fenced environment under `<home>/userspaces/<id>`. `mountsFor`
 * says which host paths the fence binds besides the userspace; the layout only carries them.
 */
export class UserspaceLayout {
  constructor(
    private readonly home: string,
    private readonly mountsFor: (userId: string) => Mount[] = () => [],
    private readonly sshFor: (userId: string) => SshGrant[] = () => [],
  ) {}

  pathFor(userId: string): Userspace {
    const root = resolve(this.home, "userspaces", userId);
    const mounts = this.mountsFor(userId);
    const ssh = this.sshFor(userId);
    return {
      id: userId,
      root,
      home: resolve(root, "home"),
      store: resolve(root, "store"),
      sessions: resolve(root, "sessions"),
      run: resolve(root, "run"),
      ...(mounts.length ? { mounts } : {}),
      ...(ssh.length ? { ssh } : {}),
    };
  }

  exists(userId: string): boolean {
    return existsSync(this.pathFor(userId).root);
  }

  /** Creates the userspace directories if missing. Idempotent. */
  ensure(userId: string): Userspace {
    const us = this.pathFor(userId);
    for (const dir of [us.home, resolve(us.store, "node_modules"), resolve(us.store, "src"), us.sessions, us.run]) {
      mkdirSync(dir, { recursive: true });
    }
    return us;
  }

  remove(userId: string): void {
    rmSync(this.pathFor(userId).root, { recursive: true, force: true });
  }
}
