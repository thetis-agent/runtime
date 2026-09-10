/** Supply only verified JavaScript under its original source URL; ADR 0037, GN-002. */
import { constants, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import validate from './metadata.mjs';
export const limits = { fileBytes: 1048576, metadataBytes: 4096, modules: 4096, totalBytes: 67108864 };
class ArtifactError extends Error {
           code                                                                      ;
  constructor(code                       , message        ) { super(message); this.code = code; }
}
function read(path        , maximum        )         {
  if (realpathSync(path) !== path) throw new ArtifactError('outside-roots', 'The execution artifact path is not canonical.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new ArtifactError('outside-roots', 'The execution artifact is not a regular file.');
    if (before.size > maximum) throw new ArtifactError('budget', 'The execution artifact exceeds its byte limit.');
    const buffer = Buffer.alloc(before.size); let position = 0;
    while (position < buffer.length) {
      const count = readSync(descriptor, buffer, position, buffer.length - position, position);
      if (!count) throw new ArtifactError('io', 'The execution artifact changed during its read.'); position += count;
    }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ArtifactError('io', 'The execution artifact changed during its read.');
    return buffer;
  } finally { closeSync(descriptor); }
}
function hash(bytes            )         { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
export function verified(path        )         {
  const source = read(path, limits.fileBytes);
  const metadata          = JSON.parse(read(`${path}.artifact.json`, limits.metadataBytes).toString('utf8'));
  if (!validate(metadata) || metadata.runtime !== process.version) throw new ArtifactError('invalid-args', 'The execution artifact metadata or runtime is incompatible.');
  const output = read(`${path}.js`, limits.fileBytes);
  if (metadata.source !== hash(source) || metadata.output !== hash(output)) throw new ArtifactError('hash-mismatch', 'The execution artifact does not match its source and output hashes.');
  return output;
}
