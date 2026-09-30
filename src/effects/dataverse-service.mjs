/**
 * Dataverse Web API as a ground-up Effect service.
 *
 * Replaces services/dataverse.mjs's fetch functions. Differences:
 * - typed errors (Data.Tagged variants) instead of thrown generic Errors
 * - every request: timeout + optional retry policy, applied per call site
 * - structured logs with span correlation (rendered by terminalLoggerLayer)
 * - the module-level webresource cache is preserved
 */
import { Context, Effect, Layer, Duration, Schedule } from "effect";
import { recordWrite } from "./echo-guard.mjs";

const validPrefix = /^[a-zA-Z].*_/;

/**
 * Represents a simplified Web Resource record from the Dataverse Web API.
 *
 * @typedef {object} WebResource
 * @property {string} createdon
 * @property {string} modifiedon
 * @property {string} name - unique name incl. virtual path ("Dev_Tools/ModernMonaco.html")
 * @property {string} webresourceid - primary key GUID
 * @property {string} content - Base64-encoded content
 * @property {number} webresourcetype - 1 HTML, 2 CSS, 3 Script, ...
 */

// ---------------------------------------------------------------------------
// Typed errors (JSDoc-friendly Data.Tagged factory — the class-based
// `Data.TaggedError("X")<{...}>` idiom requires TS generics syntax)
// ---------------------------------------------------------------------------

/** @typedef {{ _tag: "InvalidWebResourceError", name: string }} InvalidWebResourceError */
export const InvalidWebResourceError = (/** @type {string} */ name) => ({
    _tag: /** @type {const} */ ("InvalidWebResourceError"),
    name,
});

/** @typedef {{ _tag: "EmptyContentError" }} EmptyContentError */
export const EmptyContentError = () => ({ _tag: /** @type {const} */ ("EmptyContentError") });

/** @typedef {{ _tag: "HttpError", operation: string, path: string, status: number }} HttpError */
export const HttpError = (/** @type {{ operation: string, path: string, status: number }} */ props) => ({
    _tag: /** @type {const} */ ("HttpError"),
    ...props,
});

/** @typedef {{ _tag: "DecodeError", path: string, cause: unknown }} DecodeError */
export const DecodeError = (/** @type {{ path: string, cause: unknown }} */ props) => ({
    _tag: /** @type {const} */ ("DecodeError"),
    ...props,
});

/** @typedef {InvalidWebResourceError | EmptyContentError | HttpError | DecodeError} DataverseError */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @returns {number | null}
 */
export function getWebResourceType(name) {
    switch (name.split(".").pop()) {
        case "html":
        case "htm":
            return 1;
        case "css":
            return 2;
        case "js":
        case "mjs":
            return 3;
        case "xml":
            return 4;
        case "png":
            return 5;
        case "jpg":
            return 6;
        case "gif":
            return 7;
        case "xap":
            return 8;
        case "xsl":
        case "xslt":
            return 9;
        case "ico":
            return 10;
        case "svg":
            return 11;
        case "resx":
            return 12;
        default:
            return null;
    }
}

/**
 * @param {string} name
 */
export function isValidWebResource(name) {
    const webresourcetype = getWebResourceType(name);
    return validPrefix.test(name) && webresourcetype;
}

/**
 * @param {string} str
 */
function b64EncodeUnicode(str) {
    return btoa(
        encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1, 16))),
    );
}

/**
 * Standard base64 for binary data (images): bytes go through untouched,
 * unlike b64EncodeUnicode which is a UTF-8 *text* encoder — that path
 * corrupts every byte >= 0x80.
 *
 * @param {ArrayBuffer} buf
 */
function b64FromBytes(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 0x8000; // avoids arg-count limits on String.fromCharCode.apply
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + CHUNK)));
    }
    return btoa(binary);
}

/** @param {string} name @returns {boolean} */
export function isBinaryWebResource(name) {
    return /\.(png|jpe?g|gif|ico|xap|webp|avif|woff2?|ttf|otf|eot|mp3|mp4)$/i.test(name);
}

/**
 * Encode web resource content: text keeps the legacy UTF-8-safe encoding,
 * binary content (ArrayBuffer) is encoded byte-exact.
 *
 * @param {string | ArrayBuffer} content
 */
function encodeContent(content) {
    return typeof content === "string" ? b64EncodeUnicode(content) : b64FromBytes(content);
}

/**
 * @param {string} [solution]
 */
function getHeaders(solution) {
    const headers = new Headers({
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
        Prefer: "return=representation",
    });
    if (solution) headers.set("MSCRM.SolutionUniqueName", solution);
    return headers;
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** @type {Map<string,WebResource>} */
const cache = new Map();

/**
 * Typed fetch wrapper: decodes JSON, maps HTTP failures to HttpError.
 *
 * @param {string} path request path (for errors/logs)
 * @param {RequestInit} init
 * @param {string} operation label used in errors and logs
 * @returns {Effect.Effect<any, any, never>}
 */
function request(path, init, operation) {
    return Effect.tryPromise({
        try: async (signal) => {
            const res = await fetch(path, { ...init, signal });
            if (!res.ok) throw HttpError({ operation, path, status: res.status });
            
            // 204 No Content or empty bodies return null / undefined
            if (res.status === 204) return null;
            
            const text = await res.text();
            if (!text || !text.trim()) return null;
            
            return JSON.parse(text);
        },
        catch: (cause) =>
            /** @type {any} */ (cause)?._tag === "HttpError"
                ? /** @type {HttpError} */ (cause)
                : DecodeError({ path, cause }),
    }).pipe(
        Effect.withSpan(`dataverse.${operation}`, { attributes: { path } }),
        Effect.withLogSpan(`dataverse.${operation}`),
        Effect.timeout(Duration.seconds(30)),
    );
}


/**
 * Retry policy for write operations (Dataverse API flakiness):
 * exponential backoff from 300ms, max 3 retries.
 */
const writeRetry = Schedule.exponential("300 millis").pipe(
    Schedule.intersect(Schedule.recurs(3)),
);

// ---------------------------------------------------------------------------
// Service operations (top-level so the implementation can compose them)
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @returns {Effect.Effect<WebResource | undefined, DataverseError, never>}
 */
const getWebResourceEffect = (name) =>
    request(
        `/api/data/v9.2/webresourceset?$select=name,webresourceid,webresourcetype,modifiedon,createdon&$filter=name eq '${name}'&$top=1`,
        { headers: getHeaders() },
        "getWebResource",
    ).pipe(
        Effect.flatMap((body) =>
            Effect.try({
                try: () => /** @type {WebResource | undefined} */ (body?.value?.[0]),
                catch: (cause) => DecodeError({ path: name, cause }),
            }),
        ),
    );

/**
 * @param {string} root
 * @returns {Effect.Effect<WebResource[], DataverseError, never>}
 */
const getWebResourcesEffect = (root) =>
    request(
        `/api/data/v9.2/webresourceset?$select=name,webresourceid,webresourcetype,modifiedon,createdon&$filter=startswith(name,'${root}')`,
        { headers: getHeaders() },
        "getWebResources",
    ).pipe(
        Effect.flatMap((body) =>
            Effect.try({
                try: () => /** @type {WebResource[]} */ (body?.value ?? []),
                catch: (cause) => DecodeError({ path: root, cause }),
            }),
        ),
    );

/**
 * Create or update a web resource, returning the record for publishing.
 * `content` is either a text file's string or a binary file's ArrayBuffer
 * (png/jpg/ico/… — see isBinaryWebResource).
 *
 * @param {string} name
 * @param {string | ArrayBuffer} content
 * @param {string} [solution]
 * @returns {Effect.Effect<WebResource, DataverseError, never>}
 */
const uploadEffect = (name, content, solution) =>
    Effect.gen(function* () {
        if (!isValidWebResource(name)) {
            return yield* Effect.fail(InvalidWebResourceError(name));
        }
        if (!content || (typeof content === "string" && !content)) {
            return yield* Effect.fail(EmptyContentError());
        }
        const encoded = encodeContent(content);

        const cached = cache.get(name);
        if (cached) {
            yield* request(
                `/api/data/v9.2/webresourceset(${cached.webresourceid})/content`,
                {
                    headers: getHeaders(solution),
                    method: "PUT",
                    body: JSON.stringify({ value: encoded }),
                },
                "putContent",
            ).pipe(Effect.retry(writeRetry));
            yield* Effect.logDebug(`updated ${name}`).pipe(
                Effect.annotateLogs({ webresourceid: cached.webresourceid }),
            );
            return cached;
        }

        const existing = yield* getWebResourceEffect(name);
        const webresourcetype = getWebResourceType(name);
        const returned = yield* request(
            `/api/data/v9.2/webresourceset(${existing?.webresourceid ?? ""})?$select=name,webresourceid`,
            {
                headers: getHeaders(solution),
                method: existing ? "PATCH" : "POST",
                body: JSON.stringify({
                    content: encoded,
                    webresourcetype,
                    name,
                }),
            },
            existing ? "patchWebResource" : "postWebResource",
        ).pipe(Effect.retry(writeRetry));

        /** @type {WebResource | undefined} */
        let created = returned?.webresourceid ? returned : undefined;
        if (!created) {
            created = yield* getWebResourceEffect(name);
        }
        if (!created?.webresourceid) {
            return yield* Effect.fail(
                HttpError({ operation: "upload", path: name, status: 0 }),
            );
        }
        cache.set(name, created);
        yield* Effect.logDebug(`uploaded ${name}`).pipe(
            Effect.annotateLogs({
                webresourceid: created.webresourceid,
                method: existing ? "PATCH" : "POST",
            }),
        );
        return created;
    });

/**
 * Publish web resources by id (PublishXml).
 * @param {WebResource[]} value
 * @param {string} [solution]
 * @returns {Effect.Effect<void, DataverseError, never>}
 */
const publishEffect = (value, solution) =>
    Effect.gen(function* () {
        const ids = value.filter((v) => v && v.webresourceid);
        if (!ids.length) {
            yield* Effect.logDebug("publish skipped: nothing to publish");
            return;
        }
        yield* request(`/api/data/v9.2/PublishXml`, {
            method: "POST",
            headers: getHeaders(solution),
            body: JSON.stringify({
                ParameterXml: `<importexportxml><webresources>${ids
                    .map((wr) => `<webresource>${wr.webresourceid}</webresource>`)
                    .join("")}</webresources></importexportxml>`,
            }),
        }, "publish").pipe(Effect.retry(writeRetry));
        yield* Effect.logDebug(`published ${ids.length} webresource(s)`).pipe(
            Effect.annotateLogs({ count: ids.length }),
        );
    });

// ---------------------------------------------------------------------------
// Service Tag + Layer
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *     getWebResource: (name: string) => Effect.Effect<WebResource | undefined, DataverseError, never>,
 *     getWebResources: (root: string) => Effect.Effect<WebResource[], DataverseError, never>,
 *     upload: (name: string, text: string | ArrayBuffer, solution?: string) => Effect.Effect<WebResource, DataverseError, never>,
 *     publish: (webResources: WebResource[], solution?: string) => Effect.Effect<void, DataverseError, never>,
 * }} DataverseServiceImpl
 */

/**
 * The Dataverse Web API service. `yield* DataverseService` from any command.
 * @type {Context.Tag<"DataverseService", DataverseServiceImpl>}
 */
export const DataverseService = Context.GenericTag("DataverseService");

export const DataverseServiceLive = Layer.succeed(DataverseService, /** @type {DataverseServiceImpl} */ ({
    getWebResource: getWebResourceEffect,
    getWebResources: getWebResourcesEffect,
    upload: uploadEffect,
    publish: publishEffect,
}));
