/** Apply the same literal variable boundaries to requests and copied fixtures; EV-001. */
export function replace(text: string, replacements: Readonly<Record<string, string>>): string {
  const names = Object.keys(replacements).sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (!names.length) return text;
  const escaped = names.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const expression = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'gu');
  return text.replace(expression, value => replacements[value] ?? value);
}
