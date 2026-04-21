import { execFileSync } from 'child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { createHash } from 'crypto';

const DEFAULT_SNAPSHOT_MAX_FILE_SIZE = 524288;
const DEFAULT_EXCLUDE_PATTERNS = [
  '.workflow/logs/**',
  '.workflow/state/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/*.tmp'
];
const DEFAULT_INCLUDE_PATHS = [
  '.workflow/tickets',
  '.workflow/plans',
  '.workflow/reports',
  'src',
  'configs'
];

function matchesGlob(filePath, pattern) {
  // Normalize to forward slashes, strip leading ./
  const normPath = filePath.replace(/\\/g, '/');
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');

  // Build regex from glob pattern.
  // Rules:
  //   **/ at the very start  → optional prefix of zero-or-more directories
  //   /** at the end         → any file/subdir below this directory
  //   **/{seg}/**            → {seg} appears anywhere as a path component
  //   **/*.ext               → any file with .ext in any subdirectory
  //   *                      → any characters except /
  let result = '^';
  let i = 0;

  while (i < p.length) {
    const ch = p[i];

    if (ch === '*' && p[i + 1] === '*') {
      // Double-star glob
      if (i === 0 && p[i + 2] === '/') {
        // **/ at the very start: zero-or-more leading directories
        result += '(?:.+/)?';
        i += 3;
      } else if (p[i - 1] === '/' && i + 2 >= p.length) {
        // /** at the end (preceded by /): any suffix including sub-paths
        result += '.*';
        i += 2;
      } else if (p[i - 1] === '/' && p[i + 2] === '/') {
        // /**/ in the middle: optional sub-path segment
        result += '(?:.+/)?';
        i += 3;
      } else {
        // ** in any other position: match anything
        result += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // Single star: any characters except /
      result += '[^/]*';
      i++;
    } else if (ch === '?') {
      result += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      result += '\\' + ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  result += '$';

  try {
    return new RegExp(result).test(normPath);
  } catch {
    return false;
  }
}

function shouldExclude(path, excludePatterns) {
  for (const pattern of excludePatterns) {
    if (matchesGlob(path, pattern)) {
      return true;
    }
  }
  return false;
}

function computeFileHash(filePath, maxSize) {
  try {
    const stats = statSync(filePath);
    if (stats.size > maxSize) {
      return null;
    }
    const content = readFileSync(filePath);
    return createHash('sha1').update(content).digest('hex');
  } catch (e) {
    return null;
  }
}

function walkDirectory(dirPath, basePath, excludePatterns, maxFileSize) {
  const result = new Map();
  
  if (!existsSync(dirPath)) {
    return result;
  }
  
  function walk(dir) {
    try {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relativePath = relative(basePath, fullPath).replace(/\\/g, '/');
        
        if (shouldExclude(relativePath, excludePatterns)) {
          continue;
        }
        
        try {
          const stats = statSync(fullPath);
          
          if (stats.isDirectory()) {
            walk(fullPath);
          } else if (stats.isFile()) {
            const sha1 = computeFileHash(fullPath, maxFileSize);
            result.set(relativePath, {
              mtime: stats.mtimeMs,
              size: stats.size,
              sha1
            });
          }
        } catch (e) {
          console.warn(`[WARN] artifact-snapshot: skip ${relativePath}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[WARN] artifact-snapshot: walk ${dir}: ${e.message}`);
    }
  }
  
  walk(dirPath);
  return result;
}

export async function snapshot(projectRoot, options = {}) {
  const includePaths = options.includePaths || DEFAULT_INCLUDE_PATHS;
  const excludePatterns = options.excludePatterns || DEFAULT_EXCLUDE_PATTERNS;
  const snapshotMaxFileSize = options.snapshotMaxFileSize || DEFAULT_SNAPSHOT_MAX_FILE_SIZE;
  
  let gitOutput = '';
  const gitEnabled = existsSync(join(projectRoot, '.git'));
  
  if (gitEnabled) {
    try {
      gitOutput = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
        cwd: projectRoot,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (e) {
      console.warn(`[WARN] artifact-snapshot: git status failed: ${e.message}`);
      gitOutput = '';
    }
  }
  
  const fsMap = new Map();
  
  for (const includePath of includePaths) {
    const fullPath = isAbsolute(includePath) 
      ? includePath 
      : join(projectRoot, includePath);
    
    if (existsSync(fullPath)) {
      const dirMap = walkDirectory(fullPath, projectRoot, excludePatterns, snapshotMaxFileSize);
      for (const [key, value] of dirMap) {
        fsMap.set(key, value);
      }
    }
  }
  
  return {
    git: gitOutput,
    fs: fsMap,
    timestamp: Date.now()
  };
}

export function diff(before, after) {
  const created = [];
  const changed = [];
  const deleted = [];
  
  const beforeFs = before.fs;
  const afterFs = after.fs;
  
  const beforeFiles = new Set(beforeFs.keys());
  const afterFiles = new Set(afterFs.keys());
  
  for (const file of afterFiles) {
    if (!beforeFiles.has(file)) {
      created.push(file);
    } else {
      const beforeMeta = beforeFs.get(file);
      const afterMeta = afterFs.get(file);
      
      if (beforeMeta.mtime !== afterMeta.mtime ||
          beforeMeta.size !== afterMeta.size ||
          beforeMeta.sha1 !== afterMeta.sha1) {
        changed.push(file);
      }
    }
  }
  
  for (const file of beforeFiles) {
    if (!afterFiles.has(file)) {
      deleted.push(file);
    }
  }
  
  return { changed, created, deleted };
}

export function isEmpty(diffResult) {
  return diffResult.changed.length === 0 &&
         diffResult.created.length === 0 &&
         diffResult.deleted.length === 0;
}