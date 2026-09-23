// The command exports of the ui-good fixture. Each one exercises one branch of the gateway's command route.
export async function uiEcho(args, env) {
  return { text: "hi " + args.name, data: { session: env.session, user: env.user, role: env.role, cwd: typeof env.cwd, kernel: typeof env.kernel } };
}
export function uiSlow() {
  return new Promise(() => {});
}
export async function uiBoom() {
  throw new Error("no");
}
export async function uiAdmin() {
  return "admin ok";
}
export const NOT_A_FUNCTION = 1;

// The streaming exports. Each one exercises one branch of the gateway's stream route.
export async function* uiTicks(args, env) {
  for (let n = 1; n <= 3; n++) yield { n, name: args.name ?? null, session: env.session ?? null };
}
/** Yields until the browser lets go, then writes down what it saw, which is how the test reads the abort. */
export async function* uiForever(args, env) {
  try {
    for (let n = 1; ; n++) {
      yield { n };
      await new Promise((done) => setTimeout(done, 20));
    }
  } finally {
    await env.writeFile("ui-good-abort.txt", String(env.signal.aborted));
  }
}
export async function* uiErupt() {
  yield { n: 1 };
  throw new Error("burst");
}
export async function* uiAdminTicks() {
  yield "admin ok";
}
