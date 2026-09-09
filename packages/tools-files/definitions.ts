/** Declare argument schemas and mutability separately from request policy; TE-012, TE-018. */
import type { ToolDef } from '../../contracts/turn-events/types.ts';

const string = { type: 'string' };
const count = { type: 'integer', minimum: 1, maximum: 10000 };
function tool(name: string, description: string, readOnly: boolean, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, readOnly, endsTurn: false, source: 'tools-files@1.0.0', schema: { type: 'object', properties, required } };
}
export const definitions = [
  tool('read_path', 'Read lines from a file in an available space.', true, { path: string, offset: count, limit: count }, ['path']),
  tool('list_path', 'List the entries in an available directory.', true, { path: string }, ['path']),
  tool('find_files', 'Find files by glob in an available space.', true, { path: string, glob: string, max_results: count }, ['glob']),
  tool('search_files', 'Search file content in an available space.', true, { path: string, pattern: string, glob: string, mode: { enum: ['content', 'files', 'count'] }, max_results: count }, ['pattern']),
  tool('write_path', 'Write file contents in a writable space.', false, { path: string, contents: string }, ['path', 'contents']),
  tool('edit_path', 'Replace exact text in a writable file.', false, { path: string, old_text: { type: 'string', minLength: 1 }, new_text: string, replace_all: { type: 'boolean' } }, ['path', 'old_text', 'new_text']),
  tool('delete_path', 'Delete a path in a writable space.', false, { path: string, recursive: { type: 'boolean' } }, ['path'])
];
