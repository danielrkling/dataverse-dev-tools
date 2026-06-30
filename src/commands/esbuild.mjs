import { WebFileSystem } from '../fs.mjs';
import { Plugin } from '../plugin.mjs';
import { dirname, join, EXTENSIONS } from '../utils/path.mjs';
import { readJSON } from '../utils/json.mjs';

// ---- esbuild-wasm (lazy loaded) ----
const ESBUILD_CDN = 'https://unpkg.com/esbuild-wasm@0.28.1/esm/browser.min.js';

/** @type {typeof import('esbuild-wasm') | null} */
let esbuildModule = null;

/** @returns {Promise<typeof import('esbuild-wasm')>} */
async function getEsbuild() {
  if (!esbuildModule) {
    esbuildModule = await import(ESBUILD_CDN);
  }
  return /** @type {typeof import('esbuild-wasm')} */ (esbuildModule);
}

// --- CLI ARG PARSING ---

/**
 * @param {string[]} args
 * @returns {Record<string, any>}
 */
function parseCLIArgs(args) {
  /** @type {Record<string, any>} */
  const config = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    if (key === 'help') { config._help = true; continue; }
    if (key === 'minify' || key === 'no-minify') { config.minify = key === 'minify'; continue; }
    if (key === 'bundle' || key === 'no-bundle') { config.bundle = key === 'bundle'; continue; }
    if (key === 'splitting' || key === 'no-splitting') { config.splitting = key === 'splitting'; continue; }
    if (key === 'tsconfig') { config._tsconfig = true; continue; }

    if (key.startsWith('no-')) {
      config[key.slice(3)] = false;
      continue;
    }

    const next = i + 1 < args.length ? args[i + 1] : null;
    if (!next || next.startsWith('--')) continue;
    i++;

    switch (key) {
      case 'entry-points':
        config.entryPoints = next.split(',').map(s => s.trim());
        break;
      case 'outdir':
        config.outdir = next;
        break;
      case 'format':
        config.format = next;
        break;
      case 'platform':
        config.platform = next;
        break;
      case 'sourcemap':
        config.sourcemap = next === 'true' ? true : next === 'false' ? false : next;
        break;
      case 'external':
        config.external = [...(/** @type {string[]} */(config.external) || []), ...next.split(',').map(s => s.trim())];
        break;
      case 'define': {
        const eq = next.indexOf('=');
        if (eq !== -1) {
          config.define = { ...(/** @type {Record<string, string>} */(config.define) || {}), [next.slice(0, eq)]: next.slice(eq + 1) };
        }
        break;
      }
      case 'loader': {
        const eq = next.indexOf('=');
        if (eq !== -1) {
          config.loader = { ...(/** @type {Record<string, string>} */(config.loader) || {}), [next.slice(0, eq)]: next.slice(eq + 1) };
        }
        break;
      }
      case 'out-extension': {
        const eq = next.indexOf('=');
        if (eq !== -1) {
          config.outExtension = { ...(/** @type {Record<string, string>} */(config.outExtension) || {}), [next.slice(0, eq)]: next.slice(eq + 1) };
        }
        break;
      }
      case 'alias': {
        const eq = next.indexOf('=');
        if (eq !== -1) {
          config.alias = { ...(/** @type {Record<string, string>} */(config.alias) || {}), [next.slice(0, eq)]: next.slice(eq + 1) };
        }
        break;
      }
      case 'target':
        config.target = next;
        break;
    }
  }
  return config;
}

// --- TSCONFIG MERGING ---

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {Record<string, any>} config
 */
async function mergeTsconfig(fs, config) {
  const tsconfig = await readJSON(fs, 'tsconfig.json');
  if (!tsconfig?.compilerOptions) return config;

  const overrides = {};
  const { target, jsx, jsxFactory, jsxFragmentFactory, outDir, baseUrl } = tsconfig.compilerOptions;

  if (target) overrides.target = target.toLowerCase();
  if (jsx) overrides.jsx = jsx;
  if (jsxFactory) overrides.jsxFactory = jsxFactory;
  if (jsxFragmentFactory) overrides.jsxFragment = jsxFragmentFactory;
  if (outDir) overrides.outdir = outDir;
  if (baseUrl) {
    overrides.baseUrl = baseUrl;
    overrides.alias = { ...config.alias };
    const paths = tsconfig.compilerOptions.paths;
    if (paths) {
      for (const [alias, [resolved]] of Object.entries(paths)) {
        const aliasName = alias.replace(/\/\*$/, '');
        const resolvedPath = resolved.replace(/\/\*$/, '');
        overrides.alias[aliasName] = join(baseUrl, resolvedPath);
      }
    }
  }

  return { ...config, ...overrides };
}

// --- RESOLVE HELPERS ---

/**
 * @param {string} contentType
 * @param {string} url
 * @returns {'js' | 'jsx' | 'css' | 'json' | 'text'}
 */
export function getLoaderFromContentType(contentType, url) {
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

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} path
 * @returns {Promise<string | null>}
 */
async function resolveFile(fs, path) {
  for (const ext of EXTENSIONS) {
    const stat = await fs.stat(path + ext);
    if (stat.type === 'file') {
      return path + ext;
    }
  }
  return null;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function resolveDirectory(fs, dir) {
  const pkg = join(dir, 'package.json');
  if (await fs.stat(pkg)) {
    const json = await readJSON(fs, pkg);
    if (json) {
      const entry = json.module ?? json.main;
      if (entry) {
        /** @type {string | null} */
        const resolved = (await resolveFile(fs, join(dir, entry))) ?? (await resolveDirectory(fs, join(dir, entry)));
        if (resolved) return resolved;
      }
    }
  }
  return resolveFile(fs, join(dir, 'index'));
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} specifier
 * @param {string} importerDir
 * @returns {Promise<string | null>}
 */
async function resolveNodeModule(fs, specifier, importerDir) {
  const parts = specifier.split('/');
  const packageName = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = specifier.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
  let current = importerDir;

  while (true) {
    const root = join(current, 'node_modules', packageName);
    if (await fs.stat(join(root, 'package.json'))) {
      const pkg = await readJSON(fs, join(root, 'package.json'));
      if (!pkg) return null;

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

/**
 * @param {Record<string, string>} aliases
 * @param {string[]} external
 */
function aliasPlugin(aliases = {}, external = []) {
  return {
    name: 'alias-plugin',
    /** @param {import('esbuild-wasm').PluginBuild} build */
    setup(build) {
      build.onResolve({ filter: /.*/ }, (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => {
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
    /** @param {import('esbuild-wasm').PluginBuild} build */
    setup(build) {
      build.onResolve({ filter: /^https?:\/\// }, (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => ({
        path: args.path,
        namespace: 'http-url',
      }));
      build.onResolve({ filter: /.*/, namespace: 'http-url' }, (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => ({
        path: new URL(args.path, args.importer).toString(),
        namespace: 'http-url',
      }));
      build.onLoad({ filter: /.*/, namespace: 'http-url' }, async (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => {
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

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {Record<string, any>} config
 * @param {Set<string>} [trackedFiles]
 */
export function fsPlugin(fs, config = {}, trackedFiles) {
  const externals = /** @type {string[]} */ (config.external) ?? [];
  const track = trackedFiles instanceof Set;

  return {
    name: 'browser-fs',
    /** @param {import('esbuild-wasm').PluginBuild} build */
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (/** @type {import('esbuild-wasm').OnResolveArgs} */ args) => {
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

        if (track) trackedFiles.add(resolved);
        return { path: resolved, namespace: 'browser-fs' };
      });

      build.onLoad({ filter: /.*/, namespace: 'browser-fs' }, async (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => {
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
      wasmURL: 'https://unpkg.com/esbuild-wasm@0.28.1/esbuild.wasm',
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
 * @param {Record<string, any>} config
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {Set<string>} [trackedFiles]
 */
function buildOptions(config, fs, trackedFiles) {
  return {
    ...defaultConfig,
    ...config,
    write: false,
    plugins: [
      aliasPlugin(config.alias, config.external),
      httpPlugin(),
      fsPlugin(fs, config, trackedFiles),
    ],
  };
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('esbuild-wasm').BuildResult} result
 * @returns {Promise<import('esbuild-wasm').OutputFile[]>}
 */
async function writeOutputs(fs, result) {
  for (const file of result.outputFiles || []) {
    await fs.writeFile(file.path, file.contents);
  }
  return result.outputFiles || [];
}

/** @type {import('esbuild-wasm').BuildContext | null} */
let buildContext = null;

/**
 * Bundles a virtual file system in memory using esbuild.
 * For watch mode, pass useContext=true to reuse the cached context.
 * @param {WebFileSystem} fs
 * @param {import('esbuild-wasm').BuildOptions} config
 * @param {boolean} [useContext]
 * @param {Set<string>} [trackedFiles]
 * @returns {Promise<import('esbuild-wasm').OutputFile[]>}
 */
export async function bundle_in_memory(fs, config, useContext, trackedFiles) {
  await initializeEsbuildInternal();
  const esbuild = await getEsbuild();

  if (useContext && buildContext) {
    const result = await buildContext.rebuild();
    return writeOutputs(fs, result);
  }

  if (useContext) {
    buildContext = await esbuild.context(buildOptions(config, fs, trackedFiles));
    const result = await buildContext.rebuild();
    return writeOutputs(fs, result);
  }

  const result = await esbuild.build(buildOptions(config, fs, trackedFiles));
  return writeOutputs(fs, result);
}

/**
 * Bundle code to a string without writing to the filesystem.
 * Returns the output file contents as decoded strings.
 * @param {WebFileSystem} fs
 * @param {import('esbuild-wasm').BuildOptions} config
 * @param {Set<string>} [trackedFiles]
 * @returns {Promise<Array<{path: string, text: string}>>}
 */
export async function bundleToString(fs, config, trackedFiles) {
  await initializeEsbuildInternal();
  const esbuild = await getEsbuild();
  const result = await esbuild.build(buildOptions(config, fs, trackedFiles));
  const decoder = new TextDecoder();
  return (result.outputFiles || []).map(f => ({
    path: f.path,
    text: decoder.decode(f.contents),
  }));
}

// --- COMMAND ---

export default class EsbuildPlugin extends Plugin {
  get name() { return 'esbuild' }
  get commands() {
    return [
      {
        name: 'esbuild',
        aliases: ['build'],
        description: 'Bundle files using esbuild',
        usage: 'esbuild [options]',
        /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
        handler: async (args, term, { fs }) => {
          const cli = parseCLIArgs(args);
          if (cli._help) {
            return `Usage: esbuild [options]

Options:
  --entry-points <files>   Comma-separated list of entry points
  --outdir <dir>           Output directory
  --format <format>        Module format (esm, cjs, iife)
  --platform <platform>    Platform (browser, node, neutral)
  --minify / --no-minify   Minify output
  --bundle / --no-bundle   Bundle modules
  --sourcemap <mode>       Sourcemap mode (inline, external, both)
  --external <pkgs>        Comma-separated external packages
  --define <key=value>     Define a global constant
  --loader <ext=loader>    Set loader for file extension
  --target <target>        Language target (es2020, esnext, etc.)
  --tsconfig               Merge options from tsconfig.json
  --splitting              Enable code splitting
  --out-extension <ext=ext> Output file extension mapping
  --alias <from=to>        Path alias`;
          }

          const fileConfig = await readJSON(fs, 'esbuild.config.json') || {};
          const { watch: _watch, ...baseConfig } = fileConfig;

          const { _help: _h, _tsconfig: useTsconfig, ...cliOverrides } = cli;
          let merged = { ...baseConfig, ...cliOverrides };
          if (useTsconfig) merged = await mergeTsconfig(fs, merged);

          try {
            const files = await bundle_in_memory(fs, merged);
            return `Built ${files.map(v => v.path).join(', ')}`;
          } catch (e) {
            return `esbuild failed: ${e.message}`;
          }
        },
      },
    ];
  }
  /** @param {import('../plugin.mjs').InitContext} ctx */
  async init({ fs, pm, terminal: term }) {
    const config = await readJSON(fs, 'esbuild.config.json');
    if (!config) return;

    const trackedFiles = new Set();
    /** @type {string[]} */
    let watchDirs = [];

    function computeWatchDirs() {
      const dirs = new Set();
      for (const file of trackedFiles) {
        let dir = dirname(file);
        while (dir) {
          dirs.add(dir);
          const parent = dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      return [...dirs].sort((a, b) => b.length - a.length);
    }

    // Build once to warm the context
    try {
      const files = await bundle_in_memory(fs, config, true, trackedFiles);
      if (files.length > 0) term.log(`esbuild built: ${files.map(f => f.path).join(', ')}`);
      watchDirs = computeWatchDirs();
    } catch (e) {
      term.info(`esbuild: ${e.message}`);
    }

    const unsub = pm.on('fs:change', ({ path, type }) => {
      if (type !== 'modified') return;
      if (watchDirs.length > 0 && !watchDirs.some(dir => path.startsWith(dir))) return;

      bundle_in_memory(fs, config, true, trackedFiles)
        .then(files => {
          term.log(`esbuild rebuilt: ${files.map(f => f.path).join(', ')}`);
          watchDirs = computeWatchDirs();
          pm.emit('build:complete', { files, builder: 'esbuild' });
        })
        .catch(e => {
          term.error(`esbuild rebuild failed: ${e.message}`);
          pm.emit('build:error', { error: e.message, builder: 'esbuild' });
        });
    });

    return unsub;
  }
}
