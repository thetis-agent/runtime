import { randomBytes, scrypt } from "node:crypto";

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** A 64-byte scrypt key of the password under the hex salt, as hex. */
export function scryptHex(password: string, saltHex: string): Promise<string> {
  return new Promise((done, fail) => {
    scrypt(password, Buffer.from(saltHex, "hex"), 64, SCRYPT, (err, key) => (err ? fail(err) : done(key.toString("hex"))));
  });
}
