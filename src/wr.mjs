//@ts-check
const validPrefix = /^[a-zA-Z].*_/;

/**
 * Represents a simplified Web Resource record from the Dataverse Web API,
 * containing only the essential fields for the IDE.
 *
 * @typedef {object} WebResource
 * @property {string} createdon - The date and time the record was created (ISO 8601 format).
 * @property {string} modifiedon - The date and time the record was last modified (ISO 8601 format).
 * @property {string} name - The unique name of the web resource, including its virtual path (e.g., "Dev_Tools/ModernMonaco.html").
 * @property {string} webresourceid - The primary key (GUID) for the web resource.
 * @property {string} content - The content of the web resource, encoded as a Base64 string.
 * @property {number} webresourcetype - The type of web resource (e.g., 1 for HTML, 3 for CSS, 4 for Script).
 */

/**
 *
 * @param {string} [solution]
 * @returns
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

/**
 *
 * @param {string} name
 * @returns {Promise<WebResource>}
 */
export async function getWebResource(name) {
    return fetch(
        `/api/data/v9.2/webresourceset?$select=name,webresourceid,webresourcetype,modifiedon,createdon&$filter=name eq '${name}'&$top=1`,
        { headers: getHeaders() },
    )
        .then((r) => r.json())
        .then((body) => body.value[0]);
}

/**
 *
 * @param {string} root
 * @returns {Promise<WebResource[]>}
 */
export async function getWebResources(root) {
    return fetch(
        `/api/data/v9.2/webresourceset?$select=name,webresourceid,webresourcetype,modifiedon,createdon&$filter=startswith(name,'${root}')`,
        { headers: getHeaders() },
    )
        .then((r) => r.json())
        .then((v) => v.value);
}

/** @type {Map<string,WebResource>} */
const cache = new Map();

/**
 *
 * @param {string} name
 * @param {string} text
 * @param {string} [solution]
 * @returns {Promise<WebResource>}
 */
export async function uploadWebResource(name, text, solution) {
    if (!isValidWebResource(name)) throw new Error(`${name} is not a valid web resource name`);
    if (!text) throw new Error(`Content cannot be empty`);
    let wr = cache.get(name);
    if (wr) {
        const res = await fetch(`/api/data/v9.2/webresourceset(${wr.webresourceid})/content`, {
            headers: getHeaders(solution),
            method: "PUT",
            body: JSON.stringify({
                value: b64EncodeUnicode(text),
            }),
        });
        if (!res.ok) throw new Error(`Failed to update ${name}: HTTP ${res.status}`);
        return wr;
    }
    wr = await getWebResource(name);
    const webresourcetype = getWebResourceType(name);
    const res = await fetch(`/api/data/v9.2/webresourceset(${wr?.webresourceid ?? ""})?$select=name,webresourceid`, {
        headers: getHeaders(solution),
        method: wr ? "PATCH" : "POST",
        body: JSON.stringify({
            content: b64EncodeUnicode(text),
            webresourcetype,
            name,
        }),
    });
    if (!res.ok) throw new Error(`Failed to upload ${name}: HTTP ${res.status}`);
    // Prefer: return=representation gives us the full record back on create/update.
    /** @type {any} */
    const returned = await res.json();
    wr = returned?.webresourceid ? /** @type {WebResource} */ (returned) : await getWebResource(name);
    if (!wr?.webresourceid) throw new Error(`Uploaded ${name} but could not read it back for publishing`);
    cache.set(name, wr);
    return wr;
}

/**
 *
 * @param {string} name
 */
export function isValidWebResource(name) {
    const webresourcetype = getWebResourceType(name);
    return validPrefix.test(name) && webresourcetype;
}

/**
 *
 * @param {WebResource[]} value
 * @param {string} [solution]
 */
export async function publishWebResources(value, solution) {
    value = value.filter((v) => v && v.webresourceid);
    if (value.length) {
        const res = await fetch(`/api/data/v9.2/PublishXml`, {
            method: "POST",
            headers: getHeaders(solution),
            body: JSON.stringify({
                ParameterXml: `<importexportxml><webresources>${value
                    .map((wr) => `<webresource>${wr.webresourceid}</webresource>`)
                    .join("")}</webresources></importexportxml>`,
            }),
        });
        if (!res.ok) throw new Error(`Publish failed: HTTP ${res.status}`);
        return res;
    }
}

/**
 *
 * @param {string} str
 * @returns
 */
function b64EncodeUnicode(str) {
    return btoa(
        encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1, 16))),
    );
}

/**
 *
 * @param {string} name
 * @returns
 */
function getWebResourceType(name) {
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
            return null; // or any default value you prefer
    }
}
