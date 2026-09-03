// Node builtin shims for user scripts run via the `run` command.
//
// The shims are injected at bundle time by `nodeShimPlugin()` — requests for
// `fs`, `path`, `process`, `util`, `os`, `url` (with or without the `node:`
// prefix) are resolved into a virtual "node-shim" namespace and replaced with
// the sources below.
//
// All shims read their runtime state from `globalThis` lazily (at call time),
// so they work equally on the main thread and inside a worker, as long as
// `globalThis.fs` / `globalThis.process` are installed before the shimmed
// functions are invoked.

/**
 * Builtins that have a shim. Everything else that looks like a node builtin
 * gets a friendly "no shim" resolve error instead of a confusing fs miss.
 * @type {string[]}
 */
const SHIMMED = ["fs", "fs/promises", "path", "process", "util", "os", "url", "module", "assert", "crypto"];

const SHIM_RESOLVE_RE = /^(node:)?(fs|fs\/promises|path|process|util|os|url|module|assert|crypto)$/;
const BUILTIN_LIKE_RE = /^(node:)?(fs|path|process|util|os|url|module|assert|buffer|child_process|cluster|crypto|dgram|dns|events|http|http2|https|net|perf_hooks|querystring|readline|repl|stream|string_decoder|tls|tty|v8|vm|worker_threads|zlib|inspector|async_hooks)\b/;
const STUB_RESOLVE_RE = /^(node:)?(v8|vm|inspector|async_hooks|tls|dgram|cluster|http2|source-map-support|fsevents)$/;

// ---------------------------------------------------------------------------
// Stubs — modules that cannot work in a browser but whose *import* must not
// break the build. Every export throws if actually called.
// ---------------------------------------------------------------------------

const STUBS = {
    v8: ["serialize", "deserialize", "getHeapStatistics", "setFlagsFromString", "cachedDataVersionTag", "getHeapSpaceStatistics"],
    vm: ["runInContext", "runInNewContext", "runInThisContext", "createContext", "isContext", "compileFunction"],
    inspector: ["open", "url", "waitForDebugger"],
    async_hooks: ["createHook", "executionAsyncId", "triggerAsyncId", "executionAsyncResource"],
    tls: ["connect", "createServer", "TLSSocket", "DEFAULT_CIPHERS"],
    dgram: ["createSocket"],
    cluster: ["fork", "isMaster", "isPrimary", "workers"],
    http2: ["connect", "createServer"],
    // Optional npm deps some CLIs try to load inside try/catch.
    "source-map-support": ["install", "retrieveSourceMap", "mapSourcePosition", "handleUncaughtExceptions", "resetRetrieveHandlers"],
    fsevents: ["watch", "stopWatching", "setEncoding"],
};

/** @returns {string} */
function stubShimSource(mod, names) {
    const fns = names
        .map((n) => `export const ${n} = (...a) => { throw new Error("node:${mod}.${n}() is not available in the browser"); };`)
        .join("\n");
    return `${fns}\nexport default { ${names.map((n) => `${n}: () => { throw new Error("node:${mod}.${n}() is not available in the browser"); }`).join(", ")} };\n`;
}

/**
 * esbuild plugin that shims node builtin imports with inline browser shims.
 *
 * Register it BEFORE `fsPlugin()` so builtin specifiers never hit workspace /
 * node_modules resolution.
 *
 * @returns {import('esbuild-wasm').Plugin}
 */
export function nodeShimPlugin() {
    return {
        name: "node-shims",
        /** @param {import('esbuild-wasm').PluginBuild} build */
        setup(build) {
            build.onResolve({ filter: SHIM_RESOLVE_RE }, (args) => ({
                path: args.path.replace(/^node:/, ""),
                namespace: "node-shim",
            }));

            build.onResolve({ filter: STUB_RESOLVE_RE }, (args) => ({
                path: args.path.replace(/^node:/, ""),
                namespace: "node-stub",
            }));

            // Friendly error for builtins we don't shim (e.g. `node:crypto`).
            build.onResolve({ filter: BUILTIN_LIKE_RE }, (args) => {
                if (SHIM_RESOLVE_RE.test(args.path)) return;
                // Leave http(s) URLs to the httpPlugin.
                if (/^https?:\/\//.test(args.path)) return;
                return {
                    errors: [
                        { text: `No shim for node module '${args.path}'` },
                    ],
                };
            });

            build.onLoad(
                { filter: /.*/, namespace: "node-shim" },
                (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => ({
                    contents: /** @type {string} */ (SHIMS[args.path]),
                    loader: "js",
                }),
            );

            build.onLoad(
                { filter: /.*/, namespace: "node-stub" },
                (/** @type {import('esbuild-wasm').OnLoadArgs} */ args) => ({
                    contents: stubShimSource(args.path, STUBS[args.path]),
                    loader: "js",
                }),
            );
        },
    };
}

// ---------------------------------------------------------------------------
// fs / fs/promises
// ---------------------------------------------------------------------------

const FS_SHIM = `
const __fs = () => globalThis.fs;
function __op(name) {
    const fs = __fs();
    const fn = fs && (fs.promises ? fs.promises[name] : fs[name]);
    if (!fn) throw new Error("fs." + name + " is unavailable: no fs attached to globalThis");
    return fn;
}
export const readFile = (...a) => __op("readFile")(...a);
export const writeFile = (...a) => __op("writeFile")(...a);
export const appendFile = async (p, data, opts) => {
    let old = "";
    try { old = await readFile(p, "utf8"); } catch {}
    return writeFile(p, old + data, opts);
};
export const mkdir = (...a) => __op("mkdir")(...a);
export const rmdir = (...a) => __op("rmdir")(...a);
export const readdir = (...a) => __op("readdir")(...a);
export const stat = (...a) => __op("stat")(...a);
export const lstat = (...a) => __op("lstat")(...a);
export const unlink = (...a) => __op("unlink")(...a);
export const rm = (...a) => __op("rm" in (__fs()?.promises ?? {}) ? "rm" : "unlink")(...a);
export const rename = (...a) => __op("rename")(...a);
export const chmod = (...a) => __op("chmod")(...a);
export const copyFile = async (src, dest) => writeFile(dest, await readFile(src));
export const realpath = async (p) => p;
export const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
export const promises = {
    readFile, writeFile, appendFile, mkdir, rmdir, readdir, stat, lstat,
    unlink, rm, rename, chmod, copyFile, realpath, exists,
};
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

// Sync API — no synchronous fs exists in the browser, but importing these
// must not break the build. Calls throw with an actionable message.
const __sync = (name) => () => {
    throw new Error("fs." + name + "() is not supported in the browser (no sync fs) — use the promises API");
};
export const readFileSync = __sync("readFileSync");
export const writeFileSync = __sync("writeFileSync");
export const appendFileSync = __sync("appendFileSync");
export const existsSync = __sync("existsSync");
export const statSync = __sync("statSync");
export const lstatSync = __sync("lstatSync");
export const readdirSync = __sync("readdirSync");
export const mkdirSync = __sync("mkdirSync");
export const rmdirSync = __sync("rmdirSync");
export const rmSync = __sync("rmSync");
export const unlinkSync = __sync("unlinkSync");
export const realpathSync = __sync("realpathSync");
export const copyFileSync = __sync("copyFileSync");

export default { ...promises, constants, ...Object.fromEntries([
    ["readFileSync", readFileSync], ["writeFileSync", writeFileSync], ["appendFileSync", appendFileSync],
    ["existsSync", existsSync], ["statSync", statSync], ["lstatSync", lstatSync], ["readdirSync", readdirSync],
    ["mkdirSync", mkdirSync], ["rmdirSync", rmdirSync], ["rmSync", rmSync], ["unlinkSync", unlinkSync],
    ["realpathSync", realpathSync], ["copyFileSync", copyFileSync],
]) };
`;

// `fs/promises` shares the same (already promise-based) source as `fs`.
const FS_PROMISES_SHIM = FS_SHIM;

// ---------------------------------------------------------------------------
// path (posix only)
// ---------------------------------------------------------------------------

const PATH_SHIM = `
export const sep = "/";
export const delimiter = ":";

function assertPath(p) {
    if (typeof p !== "string") throw new TypeError("Path must be a string. Received " + String(p));
}

function normalizeParts(parts, allowAboveRoot) {
    const res = [];
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p || p === ".") continue;
        if (p === "..") {
            if (res.length && res[res.length - 1] !== "..") {
                res.pop();
            } else if (allowAboveRoot) {
                res.push("..");
            }
        } else {
            res.push(p);
        }
    }
    return res;
}

export function normalize(p) {
    assertPath(p);
    const isAbs = p.charCodeAt(0) === 47;
    const trailing = p.length > 1 && p.charCodeAt(p.length - 1) === 47;
    const parts = normalizeParts(p.split("/"), !isAbs);
    let out = parts.join("/");
    if (!out && !isAbs) out = ".";
    if (out && trailing) out += "/";
    return (isAbs ? "/" : "") + out;
}

export function join(...segments) {
    if (segments.length === 0) return ".";
    let joined = "";
    for (const s of segments) {
        assertPath(s);
        if (s) joined += (joined ? "/" : "") + s;
    }
    return joined ? normalize(joined) : ".";
}

export function resolve(...segments) {
    let resolved = "";
    for (let i = segments.length - 1; i >= 0 && !resolved.startsWith("/"); i--) {
        assertPath(segments[i]);
        if (segments[i]) resolved = segments[i] + (resolved ? "/" + resolved : "");
    }
    if (!resolved) throw new Error("Cannot resolve path without an absolute base (no process.cwd in browser)");
    return normalize(resolved);
}

export function isAbsolute(p) {
    assertPath(p);
    return p.length > 0 && p.charCodeAt(0) === 47;
}

export function dirname(p) {
    assertPath(p);
    if (p.length === 0) return ".";
    const hasRoot = p.charCodeAt(0) === 47;
    let end = -1;
    let matchedSlash = true;
    for (let i = p.length - 1; i >= 1; --i) {
        if (p.charCodeAt(i) === 47) {
            if (!matchedSlash) { end = i; break; }
        } else {
            matchedSlash = false;
        }
    }
    if (end === -1) return hasRoot ? "/" : ".";
    if (hasRoot && end === 1) return "//";
    return p.slice(0, end);
}

export function basename(p, ext) {
    assertPath(p);
    if (ext !== undefined) assertPath(ext);
    let start = 0;
    let end = -1;
    let matchedSlash = true;
    if (ext !== undefined && ext.length > 0 && ext.length <= p.length) {
        if (ext === p) return "";
        let extIdx = ext.length - 1;
        let firstNonSlashEnd = -1;
        for (let i = p.length - 1; i >= 0; --i) {
            const code = p.charCodeAt(i);
            if (code === 47) {
                if (firstNonSlashEnd >= 0) { start = i + 1; break; }
            } else {
                if (firstNonSlashEnd < 0) { matchedSlash = false; firstNonSlashEnd = i + 1; }
                if (code === ext.charCodeAt(extIdx)) {
                    if (--extIdx === -1) { end = i; break; }
                } else {
                    extIdx = ext.length - 1;
                }
            }
        }
        if (start === end) end = firstNonSlashEnd;
        else if (end === -1) end = p.length;
        return p.slice(start, end);
    }
    for (let i = p.length - 1; i >= 0; --i) {
        if (p.charCodeAt(i) === 47) {
            if (!matchedSlash) { start = i + 1; break; }
        } else if (end === -1) {
            matchedSlash = false;
            end = i + 1;
        }
    }
    if (end === -1) return "";
    return p.slice(start, end);
}

export function extname(p) {
    assertPath(p);
    let start = 0;
    let startDot = -1;
    let startPart = 0;
    let end = -1;
    let matchedSlash = true;
    let preDotState = 0;
    for (let i = p.length - 1; i >= 0; --i) {
        const code = p.charCodeAt(i);
        if (code === 47) {
            if (!matchedSlash) { start = i + 1; break; }
            continue;
        }
        if (end === -1) { matchedSlash = false; end = i + 1; }
        if (code === 46) {
            if (startDot === -1) startDot = i;
            else if (preDotState !== 1) preDotState = 1;
        } else if (startDot !== -1) {
            preDotState = -1;
        }
    }
    if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
        return "";
    }
    return p.slice(startDot, end);
}

export function relative(from, to) {
    assertPath(from); assertPath(to);
    if (from === to) return "";
    const fromParts = normalizeParts(from.split("/"), false);
    const toParts = normalizeParts(to.split("/"), false);
    let i = 0;
    while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
    const up = fromParts.length - i;
    const out = [];
    for (let j = 0; j < up; j++) out.push("..");
    for (let j = i; j < toParts.length; j++) out.push(toParts[j]);
    if (out.length === 0) return ".";
    return out.join("/");
}

export const posix = { normalize, join, resolve, isAbsolute, dirname, basename, extname, relative, sep, delimiter };
export default { ...posix, posix };
`;

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

const PROCESS_SHIM = `
const __proc = () => globalThis.process;
export default __proc();
export const env = __proc()?.env ?? (__proc().env = {});
export const argv = __proc()?.argv ?? (__proc().argv = []);
export const platform = __proc()?.platform ?? "browser";
export const arch = __proc()?.arch ?? "wasm32";
export const pid = 0;
export const version = __proc()?.version ?? "v22.11.0";
export const versions = __proc()?.versions ?? {};
export function cwd() { return __proc()?.cwd?.() ?? "/"; }
export function chdir(d) { __proc()?.chdir?.(d); }
export function exit(code = 0) {
    if (__proc()?.exit) return __proc().exit(code);
    throw new Error("process.exit(" + code + ")");
}
export const nextTick = (fn, ...args) => Promise.resolve().then(() => fn(...args));
const __hrStart = BigInt(Date.now()) * 1000000n;
export function hrtime(time) {
    const now = BigInt(Date.now()) * 1000000n - __hrStart;
    const [s, ns] = [Number(now / 1000000000n), Number(now % 1000000000n)];
    if (!time) return [s, ns];
    let ds = s - time[0];
    let dns = ns - time[1];
    if (dns < 0) { ds -= 1; dns += 1e9; }
    return [ds, dns];
}
hrtime.bigint = () => BigInt(Date.now()) * 1000000n - __hrStart;
`;

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

const UTIL_SHIM = `
export function format(...args) {
    return args
        .map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.stack || a.message;
            try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
        })
        .join(" ");
}
export const inspect = format;
export function promisify(fn) {
    return function promisified(...args) {
        return new Promise((resolve, reject) => {
            fn.call(this, ...args, (err, value) => (err ? reject(err) : resolve(value)));
        });
    };
}
export function callbackify(fn) {
    return function callbackified(...args) {
        const cb = args.pop();
        fn.apply(this, args).then((v) => cb(null, v), (e) => cb(e));
    };
}
export function inherits(ctor, superCtor) {
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}
export const types = { isPromise: (v) => v instanceof Promise, isDate: (v) => v instanceof Date };
export function deprecate(fn, msg) { return fn; }
export default { format, inspect, promisify, callbackify, inherits, types, deprecate };
`;

// ---------------------------------------------------------------------------
// os
// ---------------------------------------------------------------------------

const OS_SHIM = `
export function homedir() { return "/"; }
export function tmpdir() { return "/tmp"; }
export function platform() { return "browser"; }
export function arch() { return "wasm32"; }
export function type() { return "Browser"; }
export function release() { return "0.0.0"; }
export function hostname() { return globalThis.location?.hostname ?? "localhost"; }
export function cpus() {
    const n = globalThis.navigator?.hardwareConcurrency ?? 1;
    return Array.from({ length: n }, () => ({ model: "browser", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }));
}
export function userInfo() { return { username: "user", homedir: "/", shell: null }; }
export const EOL = "\\n";
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function uptime() { return 0; }
export default { homedir, tmpdir, platform, arch, type, release, hostname, cpus, userInfo, EOL, totalmem, freemem, uptime };
`;

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

const URL_SHIM = `
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export function fileURLToPath(input) {
    const url = typeof input === "string" ? new globalThis.URL(input) : input;
    if (url.protocol !== "file:") throw new TypeError("URL must be a file URL, got: " + url.href);
    let pathname = decodeURIComponent(url.pathname);
    if (url.host && url.host !== "localhost") pathname = "\\\\" + url.host + pathname; // UNC-ish
    return pathname;
}
export function pathToFileURL(path) {
    if (!path.startsWith("/")) path = "/" + path;
    return new globalThis.URL("file://" + path);
}
export function format(url, options) {
    return typeof url === "string" ? url : url.href;
}
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, format };
`;

// ---------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------

const MODULE_SHIM = `
export function createRequire(filename) {
    // Bundled CJS is converted by esbuild at build time, so a runtime
    // require can only fail — dynamic requires have no node runtime here.
    const requireFn = (id) => {
        throw new Error("createRequire() dynamic require of '" + id + "' is not supported in the browser");
    };
    requireFn.resolve = (id) => id;
    requireFn.cache = Object.create(null);
    return requireFn;
}
export const builtinModules = ["fs", "fs/promises", "path", "process", "util", "os", "url", "module"];
export class Module {}
export default { createRequire, builtinModules, Module };
`;

// ---------------------------------------------------------------------------
// assert (inline — nodepod's assert is CJS-style with no named ESM exports,
// which breaks `import { ok } from "assert"`)
// ---------------------------------------------------------------------------

const ASSERT_SHIM = `
export class AssertionError extends Error {
    constructor(options) {
        const opts = typeof options === "string" ? { message: options } : options ?? {};
        super(opts.message ?? "Assertion failed");
        this.name = "AssertionError";
        this.code = "ERR_ASSERTION";
        this.actual = opts.actual;
        this.expected = opts.expected;
        this.operator = opts.operator ?? "";
        this.generatedMessage = opts.generatedMessage ?? false;
    }
}

function __fail(actual, expected, message, operator, fn) {
    throw new AssertionError({ actual, expected, message, operator, stackStartFn: fn });
}

function __deepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null || a === undefined || b === undefined) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return a === b || (a !== a && b !== b);
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => __deepEqual(v, b[i]));
    }
    if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false;
        for (const [k, v] of a) if (!b.has(k) || !__deepEqual(v, b.get(k))) return false;
        return true;
    }
    if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false;
        for (const v of a) {
            let found = false;
            for (const w of b) if (__deepEqual(v, w)) { found = true; break; }
            if (!found) return false;
        }
        return true;
    }
    if (a instanceof Uint8Array && b instanceof Uint8Array) {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    if (typeof a === "object" && typeof b === "object") {
        const ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && __deepEqual(a[k], b[k]));
    }
    return false;
}

function assert(value, message) {
    if (!value) __fail(value, true, message ?? "Value is falsy", "==", assert);
}

assert.ok = assert;
assert.equal = (a, b, m) => { if (a != b) __fail(a, b, m, "==", assert.equal); };
assert.notEqual = (a, b, m) => { if (a == b) __fail(a, b, m, "!=", assert.notEqual); };
assert.strictEqual = (a, b, m) => { if (a !== b) __fail(a, b, m, "===", assert.strictEqual); };
assert.notStrictEqual = (a, b, m) => { if (a === b) __fail(a, b, m, "!==", assert.notStrictEqual); };
assert.deepEqual = (a, b, m) => { if (!__deepEqual(a, b)) __fail(a, b, m, "deepEqual", assert.deepEqual); };
assert.deepStrictEqual = (a, b, m) => { if (!__deepEqual(a, b)) __fail(a, b, m, "deepStrictEqual", assert.deepStrictEqual); };
assert.notDeepStrictEqual = (a, b, m) => { if (__deepEqual(a, b)) __fail(a, b, m, "notDeepStrictEqual", assert.notDeepStrictEqual); };
assert.throws = (fn, _err, m) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) __fail(undefined, undefined, m ?? "Expected function to throw", "throws", assert.throws);
};
assert.doesNotThrow = (fn, _err, m) => {
    try { fn(); } catch (e) { __fail(undefined, undefined, m ?? "Unexpected throw", "doesNotThrow", assert.doesNotThrow); }
};
assert.rejects = async (p, _err, m) => {
    let threw = false;
    try { await (typeof p === "function" ? p() : p); } catch { threw = true; }
    if (!threw) __fail(undefined, undefined, m ?? "Expected promise to reject", "rejects", assert.rejects);
};
assert.doesNotReject = async (p, _err, m) => {
    try { await (typeof p === "function" ? p() : p); } catch (e) { __fail(undefined, undefined, m ?? "Unexpected rejection", "doesNotReject", assert.doesNotReject); }
};
assert.fail = (m) => { __fail(undefined, undefined, typeof m === "string" ? m : "Failed", "fail", assert.fail); };
assert.match = (s, re, m) => { if (!re.test(s)) __fail(s, re, m, "match", assert.match); };
assert.doesNotMatch = (s, re, m) => { if (re.test(s)) __fail(s, re, m, "doesNotMatch", assert.doesNotMatch); };
assert.ifError = (e) => { if (e != null) throw e instanceof Error ? e : new AssertionError({ message: String(e) }); };
assert.AssertionError = AssertionError;
assert.strict = Object.assign(function strict(value, message) {
    if (!value) __fail(value, true, message ?? "Value is falsy", "===", assert.strict);
}, assert);
assert.strict.strict = assert.strict;

export const ok = assert.ok;
export const equal = assert.equal;
export const notEqual = assert.notEqual;
export const strictEqual = assert.strictEqual;
export const notStrictEqual = assert.notStrictEqual;
export const deepEqual = assert.deepEqual;
export const deepStrictEqual = assert.deepStrictEqual;
export const notDeepStrictEqual = assert.notDeepStrictEqual;
export const throws = assert.throws;
export const doesNotThrow = assert.doesNotThrow;
export const rejects = assert.rejects;
export const doesNotReject = assert.doesNotReject;
export const fail = assert.fail;
export const match = assert.match;
export const doesNotMatch = assert.doesNotMatch;
export const ifError = assert.ifError;
export const strict = assert.strict;
export default assert;
`;

// ---------------------------------------------------------------------------
// crypto — WebCrypto-backed where possible
// ---------------------------------------------------------------------------

const CRYPTO_SHIM = `
const __wc = globalThis.crypto;
export const webcrypto = __wc;
export const getRandomValues = (arr) => __wc.getRandomValues(arr);
export const randomUUID = () => __wc.randomUUID();
export const subtle = __wc.subtle;
export function randomBytes(size) {
    return __wc.getRandomValues(new Uint8Array(size));
}
export function createHash(algorithm) {
    throw new Error("crypto.createHash('" + algorithm + "') is not supported in the browser (only WebCrypto: subtle, getRandomValues, randomUUID)");
}
createHash.sha256 = createHash;
export function createHmac(algorithm, key) {
    throw new Error("crypto.createHmac() is not supported in the browser — use crypto.subtle.sign() with WebCrypto");
}
export const constants = {};
export const fips = false;
export default {
    webcrypto, getRandomValues, randomUUID, subtle, randomBytes,
    createHash, createHmac, constants, fips,
};
`;

/** @type {Record<string, string>} */
const SHIMS = {
    fs: FS_SHIM,
    "fs/promises": FS_PROMISES_SHIM,
    path: PATH_SHIM,
    process: PROCESS_SHIM,
    util: UTIL_SHIM,
    os: OS_SHIM,
    url: URL_SHIM,
    module: MODULE_SHIM,
    assert: ASSERT_SHIM,
    crypto: CRYPTO_SHIM,
};
