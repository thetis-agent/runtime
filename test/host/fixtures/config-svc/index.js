// Appends one line per start and stop to svc-config.log in the person's home, with the configuration at start.
export async function start(env) {
  await env.exec(`echo 'started ${JSON.stringify(env.config)}' >> svc-config.log`);
  return { stop: () => env.exec("echo stopped >> svc-config.log") };
}
