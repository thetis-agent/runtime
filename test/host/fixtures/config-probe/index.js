// Test tools: what `env.config` holds, and a document round trip through `env.storage()`.
export async function probeConfig(_args, env) {
  return JSON.stringify(env.config);
}

export async function storePut({ key, value }, env) {
  await env.storage().set(key, { value });
  return `stored ${key}`;
}

export async function storeGet({ key }, env) {
  const doc = await env.storage().get(key);
  return doc ? doc.value : "nothing";
}
