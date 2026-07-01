import { createCommand } from "../terminal.mjs";
import { readJSON } from "../utils/json.mjs";
import { dirname } from "../utils/path.mjs";
import {
  object,
  optional,
  argument,
  string,
  choice,
  flag,
  message,
} from "@optique/core";

// ---- tar extraction (inlined) ----

/**
 * Read a C-string from a Uint8Array at a given offset.
 * @param {Uint8Array} view
 * @param {number} offset
 * @param {number} maxLen
 * @returns {string}
 */
function readCString(view, offset, maxLen) {
  let end = offset;
  while (end < offset + maxLen && view[end] !== 0) end++;
  return new TextDecoder().decode(view.slice(offset, end));
}

/**
 * Extract files from a POSIX tar archive buffer.
 * Handles GNU long name extensions and strips the leading `package/` prefix.
 * @param {ArrayBuffer} buffer
 * @returns {Array<{path: string, data: Uint8Array}>}
 */
function extractTar(buffer) {
  const view = new Uint8Array(buffer);
  const files = [];
  let offset = 0;
  let longName = "";

  while (offset + 512 <= view.length) {
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (view[offset + i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break;

    const name = readCString(view, offset, 100);
    const size = parseInt(readCString(view, offset + 124, 12), 8);
    if (isNaN(size) || size < 0) break;

    const type = String.fromCharCode(view[offset + 156]);

    if (name === "././@LongLink") {
      const data = view.slice(offset + 512, offset + 512 + size);
      longName = new TextDecoder().decode(data).replace(/\0.*$/, "");
      offset += 512 + Math.ceil(size / 512) * 512;
      continue;
    }

    offset += 512;
    if (size === 0 || type === "5") {
      offset += Math.ceil(size / 512) * 512;
      continue;
    }

    const data = view.slice(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    const rawPath = longName || name;
    longName = "";

    const path = rawPath.replace(/^package\//, "");
    if (path && !path.startsWith(".") && !path.endsWith("/")) {
      files.push({ path, data });
    }

    if (offset >= view.length) break;
  }
  return files;
}

const REGISTRY = "https://registry.npmjs.org";

/**
 * @param {string} name
 * @returns {string}
 */
function registryUrl(name) {
  return `${REGISTRY}/${name.replace("/", "%2F")}`;
}

/**
 * @param {string} spec e.g. "lodash", "lodash@4.17.21", "@types/node", "@types/node@18"
 * @returns {{ name: string, version: string }}
 */
function parsePackageSpec(spec) {
  if (spec.startsWith("@")) {
    const i = spec.indexOf("@", 1);
    if (i === -1) return { name: spec, version: "latest" };
    return { name: spec.slice(0, i), version: spec.slice(i + 1) || "latest" };
  }
  const i = spec.lastIndexOf("@");
  if (i === -1) return { name: spec, version: "latest" };
  return { name: spec.slice(0, i), version: spec.slice(i + 1) || "latest" };
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>}
 */
async function decompressGzip(buffer) {
  const body = new Response(buffer).body;
  if (!body) throw new Error("Response body is null");
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

/**
 * @param {{ path: string, data: Uint8Array }[]} files
 * @param {boolean} tsOnly
 * @returns {{ path: string, data: Uint8Array }[]}
 */
function filterFiles(files, tsOnly) {
  if (!tsOnly) return files;
  return files.filter((f) => {
    if (f.path === "package.json") return true;
    return /\.(?:ts|tsx|mts|cts|d\.ts)$/i.test(f.path);
  });
}

/**
 * @param {string} v
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseSemver(v) {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

/**
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 * @returns {number}
 */
function compareSemver(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * @param {{ major: number, minor: number, patch: number }} sv
 * @param {string} range
 * @returns {boolean}
 */
function satisfies(sv, range) {
  if (!range || range === "*" || range === "latest") return true;

  if (/^\d+\.\d+\.\d+$/.test(range)) {
    const p = range.split(".");
    return sv.major === +p[0] && sv.minor === +p[1] && sv.patch === +p[2];
  }

  const c = range.match(/^\^(\d+)\.(\d+)\.(\d+)/);
  if (c) {
    const cm = +c[1],
      cmin = +c[2],
      cp = +c[3];
    if (sv.major !== cm) return false;
    if (cm === 0) {
      if (cmin === 0) return sv.patch >= cp;
      return sv.minor === cmin && sv.patch >= cp;
    }
    return sv.minor >= cmin;
  }

  const t = range.match(/^~(\d+)\.(\d+)\.(\d+)/);
  if (t) {
    return sv.major === +t[1] && sv.minor === +t[2] && sv.patch >= +t[3];
  }

  const g = range.match(/^>=(\d+)\.(\d+)\.(\d+)/);
  if (g) {
    return compareSemver(sv, { major: +g[1], minor: +g[2], patch: +g[3] }) >= 0;
  }

  return true;
}

/**
 * @param {string[]} versions
 * @param {string} range
 * @returns {string | undefined}
 */
function pickBestVersion(versions, range) {
  /** @type {Array<{ major: number, minor: number, patch: number }>} */
  const parsed = [];
  for (const v of versions) {
    if (!/^\d+\.\d+\.\d+$/.test(v)) continue;
    const sv = parseSemver(v);
    if (sv && satisfies(sv, range)) parsed.push(sv);
  }
  parsed.sort((a, b) => compareSemver(b, a));
  return parsed[0]
    ? `${parsed[0].major}.${parsed[0].minor}.${parsed[0].patch}`
    : undefined;
}

/** @type {Map<string, any>} */
const metaCache = new Map();

/**
 * @param {string} name
 * @returns {Promise<any>}
 */
async function fetchPackageMeta(name) {
  if (metaCache.has(name)) return metaCache.get(name);
  const res = await fetch(registryUrl(name));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
  const data = await res.json();
  metaCache.set(name, data);
  return data;
}

/** @type {Set<string>} */
const installing = new Set();

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {string} name
 * @param {string} version
 * @param {boolean} tsOnly
 */
async function installOne(fs, term, name, version, tsOnly) {
  if (installing.has(name)) return;
  installing.add(name);

  const targetDir = `node_modules/${name}`;
  if (await fs.exists(targetDir)) {
    term.info(`    ${name} already installed`);
    return;
  }

  const meta = await fetchPackageMeta(name);
  const versions = Object.keys(meta.versions || {});
  const resolved = pickBestVersion(versions, version || "latest");
  if (!resolved) {
    throw new Error(`No version of ${name} matches ${version}`);
  }
  const pkg = meta.versions[resolved];

  term.log(`  ↓ ${name}@${resolved}`);

  const res = await fetch(pkg.dist.tarball);
  if (!res.ok) throw new Error(`Download failed for ${name}@${resolved}`);

  const tarBuffer = await decompressGzip(await res.arrayBuffer());
  const files = extractTar(tarBuffer);
  const filtered = filterFiles(files, tsOnly);

  for (const file of filtered) {
    const fp = `${targetDir}/${file.path}`;
    const dir = dirname(fp);
    if (dir) await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fp, file.data);
  }

  term.success(`    ${name}@${resolved} installed`);

  const deps = pkg.dependencies || {};
  for (const [depName, depRange] of Object.entries(deps)) {
    try {
      await installOne(fs, term, depName, depRange, tsOnly);
    } catch (e) {
      term.error(`    Failed to install ${depName}: ${e.message}`);
    }
  }
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} name
 * @param {string} version
 */
async function updatePackageJson(fs, name, version) {
  /** @type {Record<string, any>} */
  const pkg = (await readJSON(fs, "package.json")) || {};
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies[name] = `^${version}`;
  await fs.writeFile("package.json", JSON.stringify(pkg, null, 2));
}

const npmParser = object({
  action: argument(choice(["install"]), { description: message`npm action` }),
  spec: optional(
    argument(string({ metavar: "PACKAGE" }), {
      description: message`Package name to install`,
    }),
  ),
  tsOnly: flag("--ts-only", {
    description: message`Only install TypeScript definition files`,
  }),
});

export const npmCommand = createCommand({
  name: "npm",
  parser: npmParser,
  description: "Install npm packages",
  usage: "npm install [package@version] [--ts-only]",
  brief: "Install npm packages",
  execute: async (parsed, term) => {
    const { fs } = term;
    const tsOnly = parsed.tsOnly;
    const spec = parsed.spec;

    if (spec) {
      const { name, version } = parsePackageSpec(spec);
      try {
        await installOne(fs, term, name, version, tsOnly);
        const meta = await fetchPackageMeta(name);
        const versions = Object.keys(meta.versions || {});
        const resolved = pickBestVersion(versions, version || "latest");
        if (resolved) {
          await updatePackageJson(fs, name, resolved);
          term.success(`Added ${name}@${resolved} to package.json`);
        }
      } catch (e) {
        return `npm install failed: ${e.message}`;
      }
      return "";
    }

    let pkg;
    try {
      const raw = await fs.readFile("package.json", { encoding: "utf8" });
      pkg = JSON.parse(/** @type {string} */ (raw));
    } catch {
      return "No package.json found.";
    }

    const deps = pkg.dependencies || {};
    const entries = Object.entries(deps);
    if (entries.length === 0) {
      term.info("No dependencies in package.json");
      return "";
    }

    for (const [depName, depRange] of entries) {
      try {
        await installOne(fs, term, depName, depRange, tsOnly);
      } catch (e) {
        term.error(`  Failed to install ${depName}: ${e.message}`);
      }
    }
    return "";
  },
});
