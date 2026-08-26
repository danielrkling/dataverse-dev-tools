import { createCommand } from "../terminal.mjs";
import { readJSON } from "../utils/json.mjs";
import { dirname } from "../utils/path.mjs";
import { object, optional, argument, string, message, or, command, constant, option } from "@optique/core";
import * as semver from "semver";

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

/** @type {Promise<void>} */
let fsWriteQueue = Promise.resolve();

/**
 * Run a filesystem mutation exclusively — OPFS directory handles cache state,
 * and concurrent mkdir/write on shared parents throws InvalidStateError.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withFsLock(fn) {
    const task = fsWriteQueue.then(fn);
    fsWriteQueue = task.then(
        () => {},
        () => {},
    );
    return task;
}

/**
 * Run an async mapper over items with bounded concurrency.
 * @template T
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<any>} fn
 * @param {number} [limit]
 */
async function eachWithConcurrency(items, fn, limit = 8) {
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            await fn(items[index], index);
        }
    });
    await Promise.all(workers);
}

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
 * Resolve a version spec (range, dist-tag, or bare "latest") to a concrete
 * version. Dist-tags (e.g. "alpha", "beta", "next") are looked up in the
 * package's `dist-tags` so `npm install pkg@alpha` works just like the real
 * npm CLI. Plain ranges (^1.2.3, ~1.2.3, >=, exact) are resolved against the
 * available versions with semver.
 *
 * @param {string[]} versions available versions
 * @param {Record<string, string>} distTags package metadata `dist-tags`
 * @param {string} spec range, tag, or "latest"
 * @returns {string | undefined}
 */
function pickBestVersion(versions, distTags, spec) {
    const range = spec && spec !== "latest" ? spec : "*";

    // A dist-tag that isn't a recognisable semver range wins outright.
    if (spec && spec !== "*" && !semver.validRange(spec)) {
        const tagged = distTags?.[spec];
        if (tagged) return tagged;
        // Unknown tag: fall through to the general resolver which will fail clearly.
    }

    const valid = versions.filter((v) => semver.valid(v));
    return semver.maxSatisfying(valid, range) ?? undefined;
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
/** @type {Set<string>} */
const inFlight = new Set();

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {string} name
 * @param {string} version
 * @param {boolean} tsOnly
 * @param {boolean} [force]
 */
async function installOne(fs, term, name, version, tsOnly, force = false) {
    // Recursion/cycle guard: if this package is already being resolved higher
    // up the call stack, stop. This is independent of --force so circular
    // dependency trees (e.g. A -> B -> A) can never loop forever.
    if (inFlight.has(name)) {
        term.info(`    ${name} (already resolving up the tree — skipping to avoid a cycle)`);
        return;
    }
    // Session dedupe: skip a package we've already fully installed in this run.
    // --force bypasses this so the requested package is re-fetched, but it must
    // not reopen the recursion door (the inFlight guard above already handles
    // that), and it must not re-grant entry to shared leaves in the dep tree.
    if (!force && installing.has(name)) return;

    inFlight.add(name);
    try {
        const targetDir = `node_modules/${name}`;

        const meta = await fetchPackageMeta(name);
        const versions = Object.keys(meta.versions || {});
        const resolved = pickBestVersion(versions, meta["dist-tags"] || {}, version || "latest");
        if (!resolved) {
            throw new Error(`No version of ${name} matches ${version}`);
        }

        // Read under the fs lock so we don't read a directory mid-mutation.
        // Only short-circuit when the already-installed version is exactly the one
        // we just resolved (tags like @alpha can move, so they always refetch).
        const alreadyInstalled = !force && await withFsLock(async () => {
            if (!(await fs.exists(targetDir))) return false;
            const pkgRaw = await fs.readFile(`${targetDir}/package.json`, "utf8");
            const pkgJson = JSON.parse(pkgRaw);
            return pkgJson.version === resolved || (semver.validRange(version) && semver.satisfies(pkgJson.version, version));
        });
        if (alreadyInstalled) {
            term.info(`    ${name} already installed`);
            return;
        }

        const pkg = meta.versions[resolved];

        term.log(`  ↓ ${name}@${resolved}`);

        const res = await fetch(pkg.dist.tarball);
        if (!res.ok) throw new Error(`Download failed for ${name}@${resolved}`);

        const tarBuffer = await decompressGzip(await res.arrayBuffer());
        const files = extractTar(tarBuffer);
        const filtered = filterFiles(files, tsOnly);

        // Group files by directory so we only mkdir each dir once.
        /** @type {Map<string, { path: string, data: Uint8Array }[]>} */
        const byDir = new Map();
        for (const file of filtered) {
            const fp = `${targetDir}/${file.path}`;
            const dir = dirname(fp);
            if (!byDir.has(dir)) byDir.set(dir, []);
            byDir.get(dir)?.push(file);
        }

        // All writes go through the fs lock: downloads stay parallel, disk stays serialized.
        await Promise.all(
            [...byDir.entries()].map(([dir, files]) =>
                withFsLock(async () => {
                    if (dir) await fs.mkdir(dir, { recursive: true });
                    for (const file of files) {
                        await fs.writeFile(`${targetDir}/${file.path}`, file.data);
                    }
                }),
            ),
        );

        term.success(`    ${name}@${resolved} installed`);
        installing.add(name);

        const deps = Object.entries(pkg.dependencies || {});
        await eachWithConcurrency(deps, async ([depName, depRange]) => {
            try {
                await installOne(fs, term, depName, depRange, tsOnly, force);
            } catch (e) {
                term.error(`    Failed to install ${depName}: ${e.message}`);
            }
        });
    } finally {
        inFlight.delete(name);
    }
}

/**
 * Install all dependencies from a package.json object.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {import('../terminal.mjs').WebTerminal} term
 * @param {Record<string, any>} pkg
 * @param {boolean} tsOnly
 */
async function installAll(fs, term, pkg, tsOnly) {
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const entries = Object.entries(allDeps);
    if (entries.length === 0) {
        term.info("No dependencies in package.json");
        return;
    }

    await eachWithConcurrency(entries, async ([depName, depRange]) => {
        try {
            await installOne(fs, term, depName, depRange, tsOnly);
        } catch (e) {
            term.error(`  Failed to install ${depName}: ${e.message}`);
        }
    });
}

/**
 * Read and parse package.json, returning null when missing/invalid.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<Record<string, any> | null>}
 */
async function readPackageJson(fs) {
    try {
        const raw = await fs.readFile("package.json", { encoding: "utf8" });
        return JSON.parse(/** @type {string} */ (raw));
    } catch {
        return null;
    }
}

/**
 * List all installed package names, expanding @scope folders into full names.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @returns {Promise<string[]>}
 */
async function listInstalled(fs) {
    /** @type {string[]} */
    let top = [];
    try {
        top = await fs.readdir("node_modules");
    } catch {
        return [];
    }
    /** @type {string[]} */
    const names = [];
    for (const entry of top.sort()) {
        if (entry.startsWith("@")) {
            /** @type {string[]} */
            let scoped = [];
            try {
                scoped = await fs.readdir(`node_modules/${entry}`);
            } catch {}
            for (const sub of scoped.sort()) names.push(`${entry}/${sub}`);
        } else {
            names.push(entry);
        }
    }
    return names;
}

/**
 * Get the installed version of a package, or null when not installed.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} name
 * @returns {Promise<string | null>}
 */
async function getInstalledVersion(fs, name) {
    try {
        const raw = await fs.readFile(`node_modules/${name}/package.json`, { encoding: "utf8" });
        return JSON.parse(/** @type {string} */ (raw)).version ?? null;
    } catch {
        return null;
    }
}

/** @type {Promise<void>} */
let pkgJsonQueue = Promise.resolve();

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} name
 * @param {string} version
 * @param {boolean} [dev]
 */
function updatePackageJson(fs, name, version, dev) {
    // Serialize read-modify-write cycles so concurrent installs don't clobber each other.
    const task = pkgJsonQueue.then(() => writePackageJson(fs, name, version, dev));
    pkgJsonQueue = task.catch(() => {});
    return task;
}

/**
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} name
 * @param {string} version
 * @param {boolean} [dev]
 */
async function writePackageJson(fs, name, version, dev) {
    /** @type {Record<string, any>} */
    const pkg = (await readJSON(fs, "package.json")) || {};
    if (dev) {
        pkg.devDependencies = pkg.devDependencies || {};
        pkg.devDependencies[name] = `^${version}`;
    } else {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies[name] = `^${version}`;
    }
    await withFsLock(() => fs.writeFile("package.json", JSON.stringify(pkg, null, 2)));
}

/**
 * Remove a package from dependencies/devDependencies in package.json.
 * @param {import('../fs.mjs').WebFileSystem} fs
 * @param {string} name
 */
function removeFromPackageJson(fs, name) {
    // Same serialization as updatePackageJson — read-modify-write must not interleave.
    const task = pkgJsonQueue.then(async () => {
        const pkg = (await readJSON(fs, "package.json")) || {};
        let changed = false;
        for (const section of ["dependencies", "devDependencies"]) {
            if (pkg[section]?.[name]) {
                delete pkg[section][name];
                changed = true;
            }
        }
        if (changed) {
            await withFsLock(() => fs.writeFile("package.json", JSON.stringify(pkg, null, 2)));
        }
        return changed;
    });
    pkgJsonQueue = task.then(
        () => {},
        () => {},
    );
    return task;
}

const installParser = object({
    subcommand: constant("install"),
    spec: optional(
        argument(string({ metavar: "PACKAGE" }), {
            description: message`Package name to install`,
        }),
    ),
    tsOnly: optional(
        option("--ts-only", {
            description: message`Only install TypeScript definition files`,
        }),
    ),
    dev: optional(
        option("-D", {
            description: message`Save as a devDependency`,
        }),
    ),
    force: optional(
        option("--force", {
            description: message`Force refetch and overwrite even if already installed`,
        }),
    ),
});

const runParser = object({
    subcommand: constant("run"),
    script: argument(string({ metavar: "SCRIPT" }), {
        description: message`Script name from package.json`,
    }),
});

const ciParser = object({
    subcommand: constant("ci"),
    tsOnly: optional(
        option("--ts-only", {
            description: message`Only install TypeScript definition files`,
        }),
    ),
});

const uninstallParser = object({
    subcommand: constant("uninstall"),
    spec: argument(string({ metavar: "PACKAGE" }), {
        description: message`Package name to remove`,
    }),
});

const pruneParser = object({
    subcommand: constant("prune"),
});

const lsParser = object({
    subcommand: constant("ls"),
    spec: optional(
        argument(string({ metavar: "PACKAGE" }), {
            description: message`Filter output by package name`,
        }),
    ),
});

const outdatedParser = object({
    subcommand: constant("outdated"),
});

const viewParser = object({
    subcommand: constant("view"),
    spec: argument(string({ metavar: "PACKAGE" }), {
        description: message`Package name to inspect`,
    }),
    field: optional(
        argument(string({ metavar: "FIELD" }), {
            description: message`Metadata field to display (e.g. version, description)`,
        }),
    ),
});

const initParser = object({
    subcommand: constant("init"),
    yes: optional(
        option("-y", {
            description: message`Skip questions and accept defaults`,
        }),
    ),
});

const dedupeParser = object({
    subcommand: constant("dedupe"),
});

const auditParser = object({
    subcommand: constant("audit"),
});

const whyParser = object({
    subcommand: constant("why"),
    spec: argument(string({ metavar: "PACKAGE" }), {
        description: message`Package to explain`,
    }),
});

const updateParser = object({
    subcommand: constant("update"),
    spec: optional(
        argument(string({ metavar: "PACKAGE" }), {
            description: message`Package name to update`,
        }),
    ),
    tsOnly: optional(
        option("--ts-only", {
            description: message`Only install TypeScript definition files`,
        }),
    ),
});

// optique's or() accepts at most 15 parsers, so group the commands.
const npmParser = or(
    or(
        command("install", installParser),
        command("i", installParser),
        command("run", runParser),
        command("update", updateParser),
        command("up", updateParser),
        command("uninstall", uninstallParser),
        command("remove", uninstallParser),
        command("rm", uninstallParser),
        command("un", uninstallParser),
        command("ci", ciParser),
    ),
    or(
        command("prune", pruneParser),
        command("ls", lsParser),
        command("list", lsParser),
        command("outdated", outdatedParser),
        command("view", viewParser),
        command("info", viewParser),
        command("init", initParser),
        command("dedupe", dedupeParser),
        command("audit", auditParser),
        command("why", whyParser),
        command("explain", whyParser),
    ),
);

export const npmCommand = createCommand({
    name: "npm",
    parser: npmParser,
    description: message`Manage npm packages and scripts`,
    usage: message`npm install [package] [--ts-only] [-D] [--force] | npm update [package] | npm uninstall <package> | npm ci | npm prune | npm ls [package] | npm outdated | npm view <package> [field] | npm init [-y] | npm dedupe | npm audit | npm why <package> | npm run <script>`,
    brief: message`Manage npm packages and scripts`,
    init: async (term) => {
        term.addEventListener("fs:init", async () => {
            try {
                const raw = await term.fs.readFile("package.json", { encoding: "utf8" });
                const pkg = JSON.parse(/** @type {string} */ (raw));
                if (pkg.scripts?.start) {
                    term.info(`npm run start`);
                    await term.processCommand(pkg.scripts.start);
                }
            } catch {
                // no package.json, nothing to auto-start
            }
        });
    },
    execute: async (parsed, term) => {
        const { fs } = term;
        const subcommand = parsed.subcommand;

        if (subcommand === "install") {
            const tsOnly = parsed.tsOnly ?? false;
            const dev = parsed.dev ?? false;
            const force = parsed.force ?? false;
            const spec = parsed.spec;

            if (spec) {
                const { name, version } = parsePackageSpec(spec);
                try {
                    await installOne(fs, term, name, version, tsOnly, force);
                    const meta = await fetchPackageMeta(name);
                    const versions = Object.keys(meta.versions || {});
                    const resolved = pickBestVersion(versions, meta["dist-tags"] || {}, version || "latest");
                    if (resolved) {
                        await updatePackageJson(fs, name, resolved, dev);
                        const target = dev ? "devDependencies" : "dependencies";
                        term.success(`Added ${name}@${resolved} to ${target}`);
                    }
                } catch (e) {
                    return `npm install failed: ${e.message}`;
                }
                return "";
            }

            let pkg = await readPackageJson(fs);
            if (!pkg) {
                return "No package.json found.";
            }

            await installAll(fs, term, pkg, tsOnly);
            return "";
        }

        if (subcommand === "uninstall") {
            const { name } = parsePackageSpec(parsed.spec);
            try {
                const targetDir = `node_modules/${name}`;
                if (await fs.exists(targetDir)) {
                    await withFsLock(() => fs.rm(targetDir, { recursive: true }));
                }
                installing.delete(name);
                metaCache.delete(name);

                const changed = await removeFromPackageJson(fs, name);
                if (changed) {
                    term.success(`Removed ${name} from package.json`);
                } else {
                    term.info(`Removed ${name} from node_modules (was not in package.json)`);
                }
            } catch (e) {
                return `npm uninstall failed for ${name}: ${e.message}`;
            }
            return "";
        }

        if (subcommand === "ci") {
            if (!(await fs.exists("package.json"))) {
                return "No package.json found. Nothing to ci.";
            }
            term.info("Removing node_modules...");
            try {
                await withFsLock(() => fs.rm("node_modules", { recursive: true }));
            } catch {
                // node_modules may not exist yet
            }
            installing.clear();

            let pkg = await readPackageJson(fs);
            if (!pkg) {
                return "No package.json found.";
            }
            await installAll(fs, term, pkg, parsed.tsOnly ?? false);
            return "";
        }

        if (subcommand === "prune") {
            const pkg = await readPackageJson(fs);
            if (!pkg) {
                return "No package.json found. Nothing to prune.";
            }
            const wanted = new Set([
                ...Object.keys(pkg.dependencies || {}),
                ...Object.keys(pkg.devDependencies || {}),
            ]);

            const installed = await listInstalled(fs);
            if (installed.length === 0) {
                term.info("No node_modules directory. Nothing to prune.");
                return "";
            }

            const stale = installed.filter((n) => !wanted.has(n));
            if (stale.length === 0) {
                term.success("Nothing to prune.");
                return "";
            }

            // Group scoped packages so we can remove the whole @scope dir when empty.
            /** @type {Set<string>} */
            const dirsToRemove = new Set();
            for (const name of stale) {
                if (name.startsWith("@")) dirsToRemove.add(name.split("/")[0]);
                else dirsToRemove.add(name);
            }
            // Only remove a @scope dir if every package inside it is stale.
            for (const dir of [...dirsToRemove]) {
                if (!dir.startsWith("@")) continue;
                const allStale = installed
                    .filter((n) => n.startsWith(`${dir}/`))
                    .every((n) => stale.includes(n));
                if (!allStale) dirsToRemove.delete(dir);
            }

            await eachWithConcurrency([...dirsToRemove], async (name) => {
                term.info(`Removing extraneous ${name}...`);
                await withFsLock(() => fs.rm(`node_modules/${name}`, { recursive: true }));
                installing.delete(name);
                metaCache.delete(name);
            });
            term.success(`Pruned ${stale.length} package${stale.length === 1 ? "" : "s"}`);
            return "";
        }

        if (subcommand === "ls") {
            const installed = await listInstalled(fs);
            if (installed.length === 0) {
                term.info("node_modules is empty. Run npm install first.");
                return "";
            }
            const filter = parsed.spec;
            let count = 0;
            for (const name of installed) {
                if (filter && !name.includes(filter)) continue;
                const version = await getInstalledVersion(fs, name);
                count++;
                if (version) term.log(`  ${name}@${version}`);
                else term.error(`  ${name} (missing package.json)`);
            }
            if (count === 0) term.info(`No packages matching "${filter}"`);
            return "";
        }

        if (subcommand === "outdated") {
            const pkg = await readPackageJson(fs);
            if (!pkg) return "No package.json found.";
            const entries = Object.entries({
                ...(pkg.dependencies || {}),
                ...(pkg.devDependencies || {}),
            });
            if (entries.length === 0) {
                term.info("No dependencies in package.json.");
                return "";
            }

            /** @type {Array<{ name: string, current: string, wanted: string, latest: string }>} */
            const rows = [];
            await eachWithConcurrency(entries, async ([name, range]) => {
                try {
                    const current = (await getInstalledVersion(fs, name)) ?? "(missing)";
                    const meta = await fetchPackageMeta(name);
                    const latest = meta["dist-tags"]?.latest ?? "?";
                    const wanted =
                        pickBestVersion(Object.keys(meta.versions || {}), meta["dist-tags"] || {}, range || "*") ?? "?";
                    if (current !== wanted || current !== latest) {
                        rows.push({ name, current: String(current), wanted, latest });
                    }
                } catch (e) {
                    term.error(`  Failed to check ${name}: ${e.message}`);
                }
            });

            if (rows.length === 0) {
                term.success("All dependencies are up to date.");
                return "";
            }
            const w = Math.max(...rows.map((r) => r.name.length));
            for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
                term.log(
                    `  ${r.name.padEnd(w)}  current: ${r.current.padEnd(12)} wanted: ${r.wanted.padEnd(12)} latest: ${r.latest}`,
                );
            }
            return "";
        }

        if (subcommand === "view") {
            const { name } = parsePackageSpec(parsed.spec);
            try {
                const meta = await fetchPackageMeta(name);
                const latestManifest = meta.versions?.[meta["dist-tags"]?.latest] ?? {};

                // Resolve dotted paths like "dist-tags.latest" or "dependencies.foo".
                /**
                 * @param {any} obj
                 * @param {string} path
                 */
                const resolveField = (obj, path) =>
                    path
                        .split(".")
                        .reduce((/** @type {any} */ acc, /** @type {string} */ key) => (acc == null ? acc : acc[key]), obj);

                if (parsed.field) {
                    const field = parsed.field;
                    // npm treats "version" as the latest version.
                    const value =
                        field === "version"
                            ? meta["dist-tags"]?.latest
                            : resolveField(latestManifest, field) ??
                              resolveField(meta, field);
                    if (value === undefined) {
                        return `No field "${field}" on ${name}`;
                    }
                    term.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
                } else {
                    term.log(`  ${name}@${meta["dist-tags"]?.latest ?? "?"}`);
                    if (latestManifest.description)
                        term.log(`  ${latestManifest.description}`);
                    if (latestManifest.license) term.log(`  license: ${latestManifest.license}`);
                    if (latestManifest.homepage)
                        term.log(`  homepage: ${latestManifest.homepage}`);
                    const depCount = Object.keys(latestManifest.dependencies || {}).length;
                    term.log(`  dependencies: ${depCount}`);
                }
            } catch (e) {
                return `npm view failed for ${name}: ${e.message}`;
            }
            return "";
        }

        if (subcommand === "init") {
            const existing = await readPackageJson(fs);
            if (existing && !parsed.yes) {
                return "package.json already exists. Use `npm init -y` to overwrite with defaults.";
            }
            let name = "my-project";
            try {
                const cwd = fs.cwd || "/";
                const base = cwd.split("/").filter(Boolean).pop();
                if (base) name = base;
            } catch {}

            const starter = {
                name,
                version: "1.0.0",
                description: "",
                type: "module",
                scripts: {
                    start: "echo \"Error: no script specified\" && exit 1",
                },
                dependencies: {},
                devDependencies: {},
            };
            await withFsLock(() =>
                fs.writeFile("package.json", JSON.stringify(starter, null, 2)),
            );
            term.success(`Created package.json (${name}@1.0.0). Edit it to add scripts and deps.`);
            return "";
        }

        if (subcommand === "dedupe") {
            // This installer uses a flat layout (everything in root node_modules),
            // so duplicates only occur as nested node_modules dirs from older installs.
            /** @type {string[]} */
            const nested = [];
            /**
             * @param {string} dir
             * @param {number} depth
             */
            const scan = async (dir, depth) => {
                if (depth > 6) return;
                /** @type {string[]} */
                let entries = [];
                try {
                    entries = await fs.readdir(dir);
                } catch {
                    return;
                }
                for (const entry of entries) {
                    const child = `${dir}/${entry}`;
                    if (entry === "node_modules") {
                        nested.push(child);
                        continue;
                    }
                    await scan(child, depth + 1);
                }
            };
            await scan("node_modules", 0);

            if (nested.length === 0) {
                term.success("Already deduped — no nested node_modules found.");
                return "";
            }
            await eachWithConcurrency(nested, async (dir) => {
                term.info(`Removing duplicate ${dir}...`);
                await withFsLock(() => fs.rm(dir, { recursive: true }));
            });
            term.success(`Removed ${nested.length} duplicate folder(s)`);
            return "";
        }

        if (subcommand === "audit") {
            const installed = await listInstalled(fs);
            if (installed.length === 0) {
                term.info("Nothing installed. Nothing to audit.");
                return "";
            }
            /** @type {Array<[string, string]>} */
            const packages = [];
            await eachWithConcurrency(installed, async (name) => {
                const version = await getInstalledVersion(fs, name);
                if (version) packages.push([name, version]);
            });

            // The npm registry's bulk advisories endpoint doesn't handle CORS
            // preflights (it's designed for the server-side npm CLI), so query
            // the GitHub Security Advisories API instead, which is CORS-enabled.
            term.info("Querying security advisories...");
            /** @type {Array<{ name: string, version: string, id: string, severity: string, summary: string, url: string }>} */
            const findings = [];
            let failed = 0;
            // Unauthenticated GitHub allows 60 req/hour — keep batches small.
            await eachWithConcurrency(packages.slice(0, 50), async ([name, version]) => {
                try {
                    const res = await fetch(
                        `https://api.github.com/advisories?ecosystem=npm&affects=${encodeURIComponent(`${name}@${version}`)}`,
                    );
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    /** @type {any[]} */
                    const advisories = await res.json();
                    for (const adv of advisories) {
                        findings.push({
                            name,
                            version,
                            id: adv.ghsa_id ?? "?",
                            severity: adv.severity ?? "?",
                            summary: adv.summary ?? "advisory",
                            url: adv.html_url ?? "",
                        });
                    }
                } catch {
                    failed++;
                }
            }, 4);

            if (failed > 0) {
                term.error(`  Could not check ${failed} package(s) (rate limit or network error)`);
            }

            findings.sort((a, b) => a.name.localeCompare(b.name));
            for (const f of findings) {
                term.error(`  ${f.name}@${f.version} — ${f.summary} [${f.id}, ${f.severity}]`);
                if (f.url) term.log(`    ${f.url}`);
            }
            if (findings.length === 0 && failed === 0) {
                term.success(`No known vulnerabilities found in ${packages.length} packages.`);
            } else if (findings.length > 0) {
                term.info(`Found ${findings.length} vulnerabilit${findings.length === 1 ? "y" : "ies"}.`);
            }
            return "";
        }

        if (subcommand === "why") {
            const target = parsed.spec;
            const pkg = await readPackageJson(fs);
            if (!pkg) return "No package.json found.";

            // DFS from the roots in package.json through installed manifests,
            // collecting every dependency chain that reaches the target.
            /**
             * @param {string} name
             * @param {Set<string>} visited
             * @param {string[]} chain
             * @returns {Promise<string[][]>}
             */
            const findChains = async (name, visited, chain) => {
                if (visited.has(name)) return [];
                visited.add(name);
                const nextChain = [...chain, name];
                if (name === target) return [nextChain];

                const manifest = await readJSON(fs, `node_modules/${name}/package.json`);
                if (!manifest?.dependencies) return [];
                /** @type {string[][]} */
                const chains = [];
                for (const dep of Object.keys(manifest.dependencies)) {
                    if (!(await getInstalledVersion(fs, dep))) continue;
                    chains.push(...(await findChains(dep, new Set(visited), nextChain)));
                }
                return chains;
            };

            const roots = [
                ...Object.keys(pkg.dependencies || {}),
                ...Object.keys(pkg.devDependencies || {}),
            ];
            /** @type {string[][]} */
            const allChains = [];
            for (const root of roots) {
                if (!(await getInstalledVersion(fs, root))) continue;
                allChains.push(...(await findChains(root, new Set(), [])));
            }

            if (allChains.length === 0) {
                return `${target} is not reachable from any installed dependency.`;
            }
            for (const chain of allChains.slice(0, 20)) {
                term.log("  " + chain.map((c) => c).join(" > "));
            }
            if (allChains.length > 20) {
                term.info(`...and ${allChains.length - 20} more chain(s)`);
            }
            return "";
        }

        if (subcommand === "run") {
            const scriptName = parsed.script;
            let pkg;
            try {
                const raw = await fs.readFile("package.json", { encoding: "utf8" });
                pkg = JSON.parse(/** @type {string} */ (raw));
            } catch {
                return "No package.json found. Create one to define npm scripts.";
            }
            const scripts = pkg.scripts || {};
            const scriptValue = scripts[scriptName];
            if (!scriptValue) {
                const available = Object.keys(scripts).join(", ");
                return `Script "${scriptName}" not found. Available scripts: ${available || "(none)"}`;
            }
            term.info(`> ${scriptName}: ${scriptValue}`);
            await term.processCommand(scriptValue);
        }

        if (subcommand === "update") {
            const tsOnly = parsed.tsOnly ?? false;
            const spec = parsed.spec;

            // Helper to perform the actual update of a single package
            /**
             * 
             * @param {string} name 
             * @param {string} currentRange 
             */
            const performUpdate = async (name, currentRange) => {
                term.info(`Updating ${name}...`);

                // 1. Remove the old directory in node_modules to ensure a clean slate
                const targetDir = `node_modules/${name}`;
                if (await fs.exists(targetDir)) {
                    // Assuming your WebFileSystem supports a recursive rm/unlink helper.
                    // If not, installOne will overwrite files, but removing old ones is cleaner.
                    try {
                        await withFsLock(() => fs.rm(targetDir, { recursive: true }));
                    } catch {
                        // Fallback if rm isn't implemented: proceed with overwrite
                    }
                }

                // 2. Clear the package from our in-memory installing Set to force re-download
                installing.delete(name);

                // 3. Fetch registry metadata
                const meta = await fetchPackageMeta(name);
                const versions = Object.keys(meta.versions || {});

                // If the package is in package.json, we respect its semver range limit.
                // If not, we update to "latest".
                const range = currentRange || "latest";
                const resolved = pickBestVersion(versions, meta["dist-tags"] || {}, range);

                if (!resolved) {
                    throw new Error(`No compatible version found for ${name} matching ${range}`);
                }

                // 4. Install the resolved version
                await installOne(fs, term, name, resolved, tsOnly);

                // 5. Update package.json to reflect the newly resolved version
                await updatePackageJson(fs, name, resolved, false);
                term.success(`Updated ${name} to @${resolved}`);
            };

            // Scenario A: Updating a specific package (e.g., "npm update lodash")
            if (spec) {
                const { name } = parsePackageSpec(spec);

                // Read current range from package.json if it exists
                /** @type {Record<string,any>} */
                let pkg = {}; 
                try {
                    const raw = await fs.readFile("package.json", { encoding: "utf8" });
                    pkg = JSON.parse(raw);
                } catch {}

                const currentRange = pkg.dependencies?.[name] || pkg.devDependencies?.[name];

                try {
                    await performUpdate(name, currentRange);
                } catch (e) {
                    return `npm update failed for ${name}: ${e.message}`;
                }
                return "";
            }

            // Scenario B: Updating all packages (e.g., "npm update")
            let pkg;
            try {
                const raw = await fs.readFile("package.json", { encoding: "utf8" });
                pkg = JSON.parse(raw);
            } catch {
                return "No package.json found. Nothing to update.";
            }

            const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            const entries = Object.entries(allDeps);
            if (entries.length === 0) {
                term.info("No dependencies found to update.");
                return "";
            }

            await eachWithConcurrency(entries, async ([depName, depRange]) => {
                try {
                    await performUpdate(depName, depRange);
                } catch (e) {
                    term.error(`Failed to update ${depName}: ${e.message}`);
                }
            });
            return "";
        }
    },
});
