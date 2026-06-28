import { WebFileSystem } from '../fs.mjs';

// ---- esbuild-wasm (lazy loaded) ----
const ESBUILD_CDN = 'https://unpkg.com/esbuild-wasm@0.27.2/esm/browser.min.js';
let esbuildModule = null;

async function getEsbuild() {
  if (!esbuildModule) {
    esbuildModule = await import(ESBUILD_CDN);
  }
  return esbuildModule;
}

// --- PATH UTILITIES ---

const extensions = ['', '.ts', '.mts', '.tsx', '.js', '.jsx', '.mjs', '.json'];

function pathDirname(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function dirname(path) {
  const i = path.lastIndexOf('/');
  if (i === -1) return '';
  return path.slice(0, i);
}

function join(...parts) {
  return normalize(parts.join('/'));
}

function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function normalizePath(path) {
  const parts = path.split('/');
  const result = [];
  for (const part of parts) {
    if (part === '..') {
      if (result.length > 0) result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }
  return result.join('/');
}

function getLoaderFromContentType(contentType, url) {
  if (!contentType) {
    if (url.endsWith('.css')) return 'css';
    if (url.endsWith('.json')) return 'json';
    return 'js';
  }
  if (contentType.includes('javascript') || contentType.includes('typescript')) return 'jsx';
  if (contentType.includes('css')) return 'css';
  if (contentType.includes('json')) return 'json';
  if (contentType.includes('text')) return 'text';
  return 'text';
}

// --- RESOLVE HELPERS ---

async function resolveFile(fs, path) {
  for (const ext of extensions) {
    const stat = await fs.stat(path + ext);
    if (stat.type === 'file') {
      return path + ext;
    }
  }
  return null;
}

async function resolveDirectory(fs, dir) {
  const pkg = join(dir, 'package.json');
  if (await fs.stat(pkg)) {
    try {
      const json = JSON.parse(/** @type {string} */ (await fs.readFile(pkg, { encoding: 'utf8' })));
      const entry = json.module ?? json.main;
      if (entry) {
        const resolved = (await resolveFile(fs, join(dir, entry))) ?? (await resolveDirectory(fs, join(dir, entry)));
        if (resolved) return resolved;
      }
    } catch {}
  }
  return resolveFile(fs, join(dir, 'index'));
}

async function resolveNodeModule(fs, specifier, importerDir) {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
  let current = importerDir;

  while (true) {
    const root = join(current, 'node_modules', packageName);
    if (await fs.stat(join(root, 'package.json'))) {
      let pkg;
      try {
        pkg = JSON.parse(/** @type {string} */ (await fs.readFile(join(root, 'package.json'), { encoding: 'utf8' })));
      } catch { return null; }

      if (subpath) {
        return (await resolveFile(fs, join(root, subpath))) ?? (await resolveDirectory(fs, join(root, subpath)));
      }

      const entry = pkg.module ?? pkg.browser ?? pkg.main ?? 'index';
      return (await resolveFile(fs, join(root, entry))) ?? (await resolveDirectory(fs, join(root, entry)));
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

// --- ESBUILD PLUGINS ---

function aliasPlugin(aliases = {}, external = []) {
  return {
    name: 'alias-plugin',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (external.includes(args.path)) {
          return { path: args.path, external: true };
        }
        for (const key of Object.keys(aliases)) {
          if (args.path === key || args.path.startsWith(key + '/')) {
            const alias = aliases[key];
            return {
              path: alias + args.path.slice(key.length),
              namespace: alias.startsWith('http') ? 'http-url' : args.namespace,
            };
          }
        }
        return;
      });
    },
  };
}

function httpPlugin() {
  return {
    name: 'http-plugin',
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, (args) => ({
        path: args.path,
        namespace: 'http-url',
      }));
      build.onResolve({ filter: /.*/, namespace: 'http-url' }, (args) => ({
        path: new URL(args.path, args.importer).toString(),
        namespace: 'http-url',
      }));
      build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (args) => {
        const cached = sessionStorage.getItem(args.path);
        if (cached) return JSON.parse(cached);
        try {
          const response = await fetch(args.path);
          const contents = await response.text();
          const contentType = response.headers.get('Content-Type') || '';
          const loader = getLoaderFromContentType(contentType, response.url);
          const result = { contents, loader };
          sessionStorage.setItem(response.url, JSON.stringify(result));
          return result;
        } catch {
          return { errors: [{ text: `Could not fetch content from ${args.path}` }] };
        }
      });
    },
  };
}

function fsPlugin(fs, config = {}) {
  const externals = /** @type {string[]} */ (config.external) ?? [];

  return {
    name: 'browser-fs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (externals.includes(args.path)) {
          return { path: args.path, external: true };
        }

        const importerDir = args.kind === 'entry-point' ? '' : dirname(args.importer);
        let resolved;

        if (args.path.startsWith('.') || args.path.startsWith('/')) {
          const fullPath = join(importerDir, args.path);
          resolved = (await resolveFile(fs, fullPath)) ?? (await resolveDirectory(fs, fullPath));
        } else {
          resolved = await resolveNodeModule(fs, args.path, importerDir);
        }

        if (!resolved) {
          return { errors: [{ text: `Cannot resolve '${args.path}'` }] };
        }

        return { path: resolved, namespace: 'browser-fs' };
      });

      build.onLoad({ filter: /.*/, namespace: 'browser-fs' }, async (args) => {
        const raw = await fs.readFile(args.path, { encoding: 'utf-8' });
        const contents = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        return { contents, loader: 'default' };
      });
    },
  };
}

// --- STATE AND CORE BUNDLING ---

let isEsbuildInitialized = false;

async function initializeEsbuildInternal() {
  if (isEsbuildInitialized) return;
  try {
    const esbuild = await getEsbuild();
    await esbuild.initialize({
      worker: true,
      wasmURL: 'https://unpkg.com/esbuild-wasm@0.27.2/esbuild.wasm',
    });
    isEsbuildInitialized = true;
  } catch (err) {
    if (err.message === 'Cannot call `initialize` more than once') {
      isEsbuildInitialized = true;
    } else {
      throw err;
    }
  }
}

const defaultConfig = {
  bundle: true,
  minify: false,
  format: 'esm',
};

/**
 * Bundles a virtual file system in memory using esbuild.
 * @param {WebFileSystem} fs
 * @param {import('esbuild').BuildOptions} config
 * @returns {Promise<import('esbuild').OutputFile[]>}
 */
export async function bundle_in_memory(fs, config) {
  await initializeEsbuildInternal();
  const esbuild = await getEsbuild();

  const result = await esbuild.build({
    ...defaultConfig,
    ...config,
    write: false,
    plugins: [
      aliasPlugin(config.alias, config.external),
      httpPlugin(),
      fsPlugin(fs, config),
    ],
  });

  const decoder = new TextDecoder();
  for (const file of result.outputFiles || []) {
    console.log(file);
    await fs.writeFile(file.path, file.contents);
  }

  return result.outputFiles || [];
}

// --- COMMAND ---

/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'esbuild',
  commands: [
    {
      name: 'esbuild',
      aliases: ['build'],
      description: 'Bundle files using esbuild',
      usage: 'esbuild',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        let config;
        try {
          const raw = await fs.readFile('esbuild.config.json', { encoding: 'utf8' });
          config = JSON.parse(/** @type {string} */ (raw));
        } catch {
          return 'No esbuild.config.json found. Run init-config to create it.';
        }
        try {
          const { watch: _watch, ...buildConfig } = config;
          const files = await bundle_in_memory(fs, buildConfig);
          return `Built ${files.map(v => v.path).join(', ')}`;
        } catch (e) {
          return `esbuild failed: ${e.message}`;
        }
      },
    },
  ],
};
