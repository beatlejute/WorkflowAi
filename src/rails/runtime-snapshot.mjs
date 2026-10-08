// Закреплённый runtime сессии. Исходники скила меняют только будущие запуски.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Graph } from './graph.mjs';
import { realpathDeep } from './paths.mjs';
import { loadWritePolicy, WritePolicyError } from './write-policy.mjs';
import { validateRailsConfig } from './rails-config.mjs';

function validateHandoff(config, graph) {
  if (config.handoff === undefined) return;
  const errors = validateRailsConfig(config).errors.filter((error) => error.field.startsWith('handoff'));
  if (errors.length) throw new Error(errors.map((error) => error.message).join('; '));
  for (const node of config.handoff.nodes) {
    if (!graph.node(node)) throw new Error(`handoff.nodes: неизвестный узел ${node}`);
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Не меняет узел, историю, счётчики или идентификатор запуска. */
export function pinnedRuntime(root, state, loadLive) {
  try {
    loadWritePolicy(root); // хранилище не может быть ссылкой или общим файлом
    if (!state?.session || !state.skill || !state.started) {
      throw new Error('нет идентификатора активного запуска');
    }
    const identity = {
      root: realpathDeep(root), session: state.session, skill: state.skill,
      run: state.run ?? null, started: state.started,
    };
    const id = digest(identity);
    const directory = join(root, '.workflow', 'state', 'rails-runtime');
    const path = join(directory, `${id}.json`);
    if (state.runtime && (state.runtime.version !== 1 || state.runtime.id !== id || !/^[a-f0-9]{64}$/.test(state.runtime.hash))) {
      throw new Error('повреждена привязка runtime');
    }
    const readSnapshot = () => {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('snapshot доступен через ссылку');
      return JSON.parse(readFileSync(path, 'utf8'));
    };
    let snapshot;
    try {
      snapshot = readSnapshot();
    } catch (error) {
      if (error.code !== 'ENOENT' || state.runtime) throw error;
      const { config, graph } = loadLive();
      validateHandoff(config, graph);
      const payload = {
        version: 1, identity, launch: state.launch ?? null, config,
        graph: { occurrences: graph._occurrences, edges: graph._edges, files: graph._files, errors: graph._parseErrors },
      };
      snapshot = { payload, hash: digest(payload) };
      mkdirSync(directory, { recursive: true });
      try {
        writeFileSync(path, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        snapshot = readSnapshot();
      }
    }
    const payload = snapshot?.payload;
    if (!payload || payload.version !== 1 || digest(payload.identity) !== id || digest(payload) !== snapshot.hash
      || (state.runtime && state.runtime.hash !== snapshot.hash)
      || digest(payload.launch ?? null) !== digest(state.launch ?? null)
      || !payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)
      || !payload.graph || !['occurrences', 'edges', 'files', 'errors'].every((field) => Array.isArray(payload.graph[field]))) {
      throw new Error('повреждён snapshot runtime');
    }
    const data = payload.graph;
    const graph = new Graph(data.occurrences, data.edges, data.files, data.errors);
    validateHandoff(payload.config, graph);
    state.runtime = { version: 1, id, hash: snapshot.hash };
    return { config: payload.config, graph };
  } catch (error) {
    throw new WritePolicyError(`runtime не закреплён: ${error.message}`);
  }
}
