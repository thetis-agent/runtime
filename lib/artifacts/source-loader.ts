/** Enable repository imports during explicit source execution; ADR 0047. */
import { registerHooks } from 'node:module';
import { rootImport } from './aliases.mjs';
registerHooks({ resolve: rootImport });
