// Политика физических целей. Разрешения обслуживания задаёт владелец вне скилов.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../lib/js-yaml.mjs';
import { realpathDeep } from './paths.mjs';

const installationPath = dirname(fileURLToPath(import.meta.url));

export class WritePolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WritePolicyError';
    this.railsFailClosed = true;
  }
}

function key(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inside(path, root) {
  const tail = relative(key(root), key(path));
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}

function plainPath(path, root) {
  const tail = relative(resolve(root), resolve(path));
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) return false;
  let current = resolve(root);
  for (const segment of tail.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) return false;
    if (stat.isFile() && stat.nlink > 1) return false;
  }
  return true;
}

function plainTree(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) return stat.nlink === 1;
  if (!stat.isDirectory()) return false;
  for (const entry of readdirSync(root)) {
    if (!plainTree(join(root, entry))) return false;
  }
  return true;
}

function absolutePaths(value, field) {
  if (!Array.isArray(value) || value.some((p) => typeof p !== 'string' || !isAbsolute(p) || /[*?]/.test(p))) {
    throw new WritePolicyError(`${field}: требуются точные абсолютные пути без wildcard`);
  }
  return value.map((p) => realpathDeep(p));
}

export function loadWritePolicy(root) {
  const installedRails = realpathDeep(installationPath);
  const installedSkills = realpathDeep(join(installedRails, '..', 'skills'));
  const policyPath = join(root, '.workflow', 'rails-policy.yaml');
  const snapshots = join(root, '.workflow', 'state', 'rails-runtime');
  if (!plainPath(policyPath, root) || !plainPath(snapshots, root)) {
    throw new WritePolicyError('политика или хранилище runtime доступны через ссылку/общий файл');
  }
  let raw = {};
  if (existsSync(policyPath)) {
    try {
      raw = load(readFileSync(policyPath, 'utf8'));
    } catch (error) {
      throw new WritePolicyError(`не удалось прочитать внешнюю политику: ${error.message}`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) {
      throw new WritePolicyError('неподдерживаемая внешняя политика rails');
    }
  }
  const canonical = [installedSkills, ...absolutePaths(raw.canonical_skill_roots ?? [], 'canonical_skill_roots')];
  const protectedPaths = [realpathDeep(policyPath), realpathDeep(snapshots), realpathDeep(join(root, '.workflow', 'state', 'rails'))];
  let maintenance = [];
  if (raw.maintenance !== undefined) {
    const grant = raw.maintenance;
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
      throw new WritePolicyError('maintenance: требуется объект');
    }
    const expiry = typeof grant.expires_at === 'string' ? Date.parse(grant.expires_at) : NaN;
    if (!Number.isFinite(expiry)) throw new WritePolicyError('maintenance.expires_at: требуется срок разрешения');
    const paths = absolutePaths(grant.write_paths, 'maintenance.write_paths');
    if (paths.some((p) => protectedPaths.some((guard) => inside(p, guard)))) {
      throw new WritePolicyError('обслуживание не может разрешать изменение политики или состояния runtime');
    }
    if (Date.now() < expiry) maintenance = paths;
  }
  return {
    canonical, infrastructure: [installedRails], protectedPaths, maintenance,
    // Свободная правка независимых скилов — прерогатива скила-коуча (правило
    // проекта «изменения скилов только через коуча на рельсах»); список можно
    // переопределить политикой authoritative_skills (ревью 2026-10-05, второй раунд).
    authorities: absoluteStrings(raw.authoritative_skills) ?? ['coach'],
  };
}

function absoluteStrings(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !s)) {
    throw new WritePolicyError('authoritative_skills: требуется список имён скилов');
  }
  return value;
}

function localSkill(root, display, real, policy) {
  const mount = join(root, '.workflow', 'src', 'skills');
  const tail = relative(resolve(mount), resolve(display));
  if (isAbsolute(tail) || tail === '..' || tail.startsWith(`..${sep}`)) return false;
  const name = tail.split(sep)[0];
  if (!name || name === '.') return false;
  const skillDir = join(mount, name);
  if (!existsSync(skillDir)) {
    // Новый скил: каталога ещё нет — первый Write его создаёт. Голый файл в корне
    // skills/ новым скилом не считается (tail из одного сегмента). Сам каталог
    // скилов должен быть обычным каталогом проекта и не вести в канон (иначе новый
    // скил писался бы в каноническое дерево).
    const mountReal = realpathDeep(mount);
    return tail.split(sep).length >= 2
      && existsSync(mount)
      && plainPath(mount, root)
      && !policy.canonical.some((canon) => inside(mountReal, canon));
  }
  if (!plainPath(skillDir, root) || !plainPath(display, skillDir)) return false;
  const physical = realpathDeep(skillDir);
  if (!inside(physical, realpathDeep(root)) || !inside(real, physical)) return false;
  if (policy.canonical.some((canon) => inside(physical, canon) || inside(canon, physical))) return false;
  return plainTree(skillDir);
}

/** Проверяется до роли executor и до исключения CLI. Никакого allow при ошибке. */
export function classifyWrites(root, targets, kind, cwd = root, callerSkill = null) {
  try {
    return classifyTargets(root, targets, kind, cwd, callerSkill);
  } catch (error) {
    if (error instanceof WritePolicyError) throw error;
    throw new WritePolicyError(`проверка физических целей не выполнена: ${error.message}`);
  }
}

function classifyTargets(root, targets, kind, cwd, callerSkill) {
  const unrestricted = new Set();
  if (targets.length === 0) return { unrestricted };
  const policy = loadWritePolicy(root);
  for (const target of targets) {
    if (target.marker) continue; // путь не определён — его ведёт слой режимов, послабления нет
    const real = realpathDeep(target.real);
    if (policy.protectedPaths.some((guard) => inside(real, guard))) {
      throw new WritePolicyError(`защищённая политика/состояние: ${target.display}`);
    }
    const maintenance = policy.maintenance.some((allowed) => key(real) === key(allowed));
    // Общий inode (hardlink) — потенциальная алиас-запись в канон: realpath его не
    // раскрывает, поэтому без явного разрешения — fail-closed (ревью 2026-10-05).
    // Новый файл (ENOENT) общим быть не может; иная ошибка stat — отказ.
    let sharedInode = false;
    try { sharedInode = lstatSync(target.real).nlink > 1; } catch (error) { sharedInode = error.code !== 'ENOENT'; }
    if (sharedInode && !maintenance) throw new WritePolicyError(`цель — общий файл (hardlink): ${target.display}`);
    const canonical = [...policy.canonical, ...policy.infrastructure].some((guard) => inside(real, guard));
    if (canonical && !maintenance) throw new WritePolicyError(`каноническая цель защищена: ${target.display}`);
    // Неизвестная внешняя цель проектного скила не является независимой копией.
    const mount = join(root, '.workflow', 'src', 'skills');
    const display = resolve(cwd, target.display);
    const lexicalSkill = inside(display, resolve(mount));
    const editWriteShell = kind === 'edit' || kind === 'write' || kind === 'shell';
    // Независимость открывает только авторизованный скил (по умолчанию коуч);
    // остальным сессиям область скилов закрывают правила стадии.
    const authoritative = policy.authorities.includes(callerSkill);
    const independent = editWriteShell && authoritative && localSkill(root, display, real, policy);
    // Отказ «не независимая копия» — для Edit/Write и для shell без скила сессии:
    // у делегата executor правил стадии нет, его shell-запись в дерево скилов
    // закрывается здесь (ревью 2026-10-05, третий раунд); у shell-команды сессии
    // скила область решает режим стадии, защита канона/protected выше уже сработала.
    if (lexicalSkill && !independent && !maintenance
      && (kind === 'edit' || kind === 'write' || callerSkill == null)) {
      throw new WritePolicyError(`скил не является независимой локальной копией: ${target.display}`);
    }
    if (editWriteShell && (independent || maintenance)) unrestricted.add(target.real);
  }
  return { unrestricted };
}
