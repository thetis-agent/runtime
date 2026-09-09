/** Render the immutable prompt head once and reuse stored bytes; ADR 0013, TE-009. */
import { createHash } from 'node:crypto';
import type { Message, Prefix, ToolDef } from '../../contracts/turn-events/types.ts';
import type { Entry as SkillEntry } from '../../contracts/skills/types.ts';
import type { RequestEvent } from '../../contracts/provider/types.ts';

export function hash(value: string): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

export function renderPrefix(system: readonly Message[], entries: readonly SkillEntry[], tools: readonly ToolDef[]): Prefix {
  const messages: RequestEvent[] = system.map(message => ({ type: 'message', role: message.role, content: message.content }));
  for (const entry of entries) {
    const description = typeof entry['description'] === 'string' ? entry['description'] : entry.path;
    messages.push({ type: 'message', role: 'system', content: [{ type: 'text', text: `# skill: ${entry.id} (${entry.pack}@${entry.version})\n${entry.body ?? description}` }] });
  }
  const definitions: RequestEvent[] = tools.map(tool => ({ type: 'tool', name: tool.name, description: tool.description, schema: tool.schema }));
  return {
    rendererVersion: '1.0.0', systemHash: hash(JSON.stringify(system)),
    skills: entries.map(({ id, pack, version, contentHash }) => ({ id, pack, version, contentHash })),
    offer: tools.map(tool => ({ name: tool.name, source: tool.source, schemaHash: hash(JSON.stringify(tool.schema)) })),
    bytes: JSON.stringify([...messages, ...definitions])
  };
}
