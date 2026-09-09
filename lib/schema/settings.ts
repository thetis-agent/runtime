/** Materialize declared defaults without allowing settings to become policy; ADR 0016 §1. */
import { isObject } from './index.ts';

export function configured(schema: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  const output = structuredClone(input); const properties = schema['properties'];
  if (isObject(properties)) for (const [name, property] of Object.entries(properties)) if (output[name] === undefined && isObject(property) && 'default' in property) output[name] = structuredClone(property['default']);
  return output;
}
