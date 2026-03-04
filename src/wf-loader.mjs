/**
 * ESM loader that adds wf's node_modules as a fallback for module resolution.
 * Used via NODE_OPTIONS=--import to allow target project scripts to use
 * wf's dependencies without installing them locally.
 */
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wfNodeModules = join(__dirname, '..', 'node_modules');

register(
  'data:text/javascript,' + encodeURIComponent(`
    import { pathToFileURL } from 'node:url';
    const base = ${JSON.stringify('file:///' + wfNodeModules.replace(/\\/g, '/') + '/')};

    export async function resolve(specifier, context, nextResolve) {
      try {
        return await nextResolve(specifier, context);
      } catch (err) {
        if (err.code === 'ERR_MODULE_NOT_FOUND' && !specifier.startsWith('.') && !specifier.startsWith('/')) {
          return nextResolve(specifier, { ...context, parentURL: base });
        }
        throw err;
      }
    }
  `),
  pathToFileURL('./')
);
