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
    `/api/data/v9.2/webresourceset?$select=name,webresourceid,content,webresourcetype,modifiedon,createdon&$filter=name eq '${name}'&$top=1`,
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
    `/api/data/v9.2/webresourceset?$select=name,webresourceid,content,webresourcetype,modifiedon,createdon&$filter=startswith(name,'${root}')`,
    { headers: getHeaders() },
  )
    .then((r) => r.json())
    .then((v) => v.value);
}

/**
 *
 * @param {string} name
 */
export async function deleteWebResource(name) {
  return getWebResource(name).then((wr) => {
    if (wr) {
      return fetch(`/api/data/v9.2/webresourceset(${wr.webresourceid})`, {
        headers: getHeaders(),
        method: "DELETE",
      });
    }
  });
}

/**
 *
 * @param {string} name
 * @param {string} text
 * @param {string} [solution]
 * @returns {Promise<WebResource | undefined>}
 */
export async function uploadWebResource(name, text, solution) {
  if (isValidWebResource(name) && text) {
    const wr = await getWebResource(name);
    const webresourcetype = getWebResourceType(name);
    const result = await fetch(
      `/api/data/v9.2/webresourceset(${
        wr?.webresourceid ?? ""
      })?$select=name,webresourceid`,
      {
        headers: getHeaders(solution),
        method: wr ? "PATCH" : "POST",
        body: JSON.stringify({
          content: b64EncodeUnicode(text),
          webresourcetype,
          name,
        }),
      },
    ).then((r) => r.json());
    return result;
  }
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
    return fetch(`/api/data/v9.2/PublishXml`, {
      method: "POST",
      headers: getHeaders(solution),
      body: JSON.stringify({
        ParameterXml: `<importexportxml><webresources>${value
          .map((wr) => `<webresource>${wr.webresourceid}</webresource>`)
          .join("")}</webresources></importexportxml>`,
      }),
    });
  }
}

/**
 *
 * @param {string} str
 * @returns
 */
function b64EncodeUnicode(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (match, p1) =>
      String.fromCharCode(parseInt("0x" + p1, 16)),
    ),
  );
}

/**
 * Decodes a Base64 string that was encoded with Unicode support.
 * This is the direct inverse of the b64EncodeUnicode function.
 *
 * @param {string} str The Base64 encoded string.
 * @returns {string} The original, decoded Unicode string.
 */
function b64DecodeUnicode(str) {
  return decodeURIComponent(
    atob(str)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join(""),
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

/**
 * Represents a Solution record from the Dataverse Web API,
 * containing identifying information for a solution.
 *
 * @typedef {object} Solution
 * @property {string} solutionid - The primary key (GUID) for the solution record.
 * @property {string} uniquename - The unique, non-localizable name used by the system to identify the solution (e.g., "Active", "Default").
 * @property {string} friendlyname - The localizable display name shown to users in the UI (e.g., "Active Solution").
 */

/**
 *
 * @returns {Promise<Solution[]>}
 */
export async function getSolutions() {
  return fetch(
    `/api/data/v9.2/solutions?$select=friendlyname,uniquename&$filter=ismanaged eq false`,
  )
    .then((s) => s.json())
    .then((v) => v.value);
}

