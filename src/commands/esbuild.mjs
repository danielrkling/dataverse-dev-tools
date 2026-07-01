import { WebFileSystem } from '../fs.mjs';
import { createOptiquePlugin } from '../plugin.mjs';
import { dirname, join, EXTENSIONS } from '../utils/path.mjs';
import { readJSON } from '../utils/json.mjs';
import { object, optional, flag, option, string, passThrough } from '@optique/core';

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

const esbuildParser = object({
  entryPoints: optional(option('--entry-points', string({ metavar: 'FILES' }), { description: 'Comma-separated entry points' })),
  outdir: optional(option('--outdir', string({ metavar: 'DIR' }), { description: 'Output directory' })),
  format: optional(option('--format', string({ metavar: 'FORMAT' }), { description: 'Module format (esm, cjs, iife)' })),
  platform: optional(option('--platform', string({ metavar: 'PLATFORM' }), { description: 'Platform (browser, node, neutral)' })),
  sourcemap: optional(option('--sourcemap', string({ metavar: 'MODE' }), { description: 'Sourcemap mode (inline, external, both)' })),
  target: optional(option('--target', string({ metavar: 'TARGET' }), { description: 'Language target (es2020, esnext, etc.)' })),
  external: optional(option('--external', string({ metavar: 'PKGS' }), { description: 'Comma-separated external packages' })),
  define: optional(option('--define', string({ metavar: 'KEY=VALUE' }), { description: 'Define a global constant' })),
  loader: optional(option('--loader', string({ metavar: 'EXT=LOADER' }), { description: 'Set loader for file extension' })),
  outExtension: optional(option('--out-extension', string({ metavar: 'EXT=EXT' }), { description: 'Output file extension mapping' })),
  alias: optional(option('--alias', string({ metavar: 'FROM=TO' }), { description: 'Path alias' })),
  minify: optional(flag('--minify', { description: 'Minify output' })),
  noMinify: optional(flag('--no-minify', { description: 'Disable minification' })),
  bundle: optional(flag('--bundle', { description: 'Bundle modules' })),
  noBundle: optional(flag('--no-bundle', { description: 'Disable bundling' })),
  splitting: optional(flag('--splitting', { description: 'Enable code splitting' })),
  noSplitting: optional(flag('--no-splitting', { description: 'Disable code splitting' })),
  tsconfig: optional(flag('--tsconfig', { description: 'Merge options from tsconfig.json' })),
  rest: passThrough(),
});

/**
 * @param {Record<string, any>} parsed
 * @returns {Record<string, any>}
 */
function parsedToCliOverrides(parsed) {
  /** @type {Record<string, any>} */
  const config = {};

  if (parsed.entryPoints) config.entryPoints = parsed.entryPoints.split(',').map(s => s.trim());
  if (parsed.outdir) config.outdir = parsed.outdir;
  if (parsed.format) config.format = parsed.format;
  if (parsed.platform) config.platform = parsed.platform;
  if (parsed.target) config.target = parsed.target;
  if (parsed.sourcemap) {
    config.sourcemap = parsed.sourcemap === 'true' ? true : parsed.sourcemap === 'false' ? false : parsed.sourcemap;
  }
  if (parsed.external) config.external = parsed.external.split(',').map(s => s.trim());
  if (parsed.define) {
    const eq = parsed.define.indexOf('=');
    if (eq !== -1) config.define = { [parsed.define.slice(0, eq)]: parsed.define.slice(eq + 1) };
  }
  if (parsed.loader) {
    const eq = parsed.loader.indexOf('=');
    if (eq !== -1) config.loader = { [parsed.loader.slice(0, eq)]: parsed.loader.slice(eq + 1) };
  }
  if (parsed.outExtension) {
    const eq = parsed.outExtension.indexOf('=');
    if (eq !== -1) config.outExtension = { [parsed.outExtension.slice(0, eq)]: parsed.outExtension.slice(eq + 1) };
  }
  if (parsed.alias) {
    const eq = parsed.alias.indexOf('=');
    if (eq !== -1) config.alias = { [parsed.alias.slice(0, eq)]: parsed.alias.slice(eq + 1) };
  }
  if (parsed.minify) config.minify = true;
  if (parsed.noMinify) config.minify = false;
  if (parsed.bundle) config.bundle = true;
  if (parsed.noBundle) config.bundle = false;
  if (parsed.splitting) config.splitting = true;
  if (parsed.noSplitting) config.splitting = false;

  for (const arg of parsed.rest ?? []) {
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key.startsWith('no-')) {
      config[key.slice(3)] = false;
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

export default createOptiquePlugin({
  name: 'esbuild',
  commands: [
    {
      name: 'esbuild',
      parser: esbuildParser,
      aliases: ['build'],
      description: 'Bundle files using esbuild',
      usage: 'esbuild [options]',
      brief: 'Bundle files using esbuild',
      execute: async (parsed, term, { fs }) => {
        const fileConfig = await readJSON(fs, 'esbuild.config.json') || {};
        const { watch: _watch, ...baseConfig } = fileConfig;

        const useTsconfig = parsed.tsconfig;
        const cliOverrides = parsedToCliOverrides(parsed);
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
  ],
  init: async ({ fs, pm, terminal: term }) => {
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
  },
});
