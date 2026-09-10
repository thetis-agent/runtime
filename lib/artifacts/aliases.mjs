/** Resolve repository imports within the importing revision, without changing authority; ADR 0047. */
import { createRequire, findPackageJSON } from 'node:module';
                                                   
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

export const rootImport                  = (specifier, context, nextResolve) => {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
  const path = specifier.slice(2);
  if (path.length > 4096 || !path.split('/').every(part => /^[\w.-]+$/u.test(part) && part !== '.' && part !== '..')) {
    throw Object.assign(new Error('The root import is not a canonical module path.'), { code: 'outside-roots' });
  }
  const manifest = context.parentURL?.startsWith('file:') ? findPackageJSON(context.parentURL) : undefined;
  if (!manifest) throw Object.assign(new Error('The root import has no installed package scope.'), { code: 'outside-roots' });
  const scope = dirname(manifest); const category = basename(dirname(scope));
  const metadata          = require(manifest);
  const runtime = typeof metadata === 'object' && metadata !== null && 'name' in metadata && metadata.name === 'thetis';
  const root = runtime ? scope : ['lib', 'contracts', 'packages'].includes(category) ? dirname(dirname(scope))
    : ['kernel', 'test'].includes(basename(scope)) ? dirname(scope) : scope;
  return nextResolve(new URL(path, pathToFileURL(`${root}/`)).href, context);
};
