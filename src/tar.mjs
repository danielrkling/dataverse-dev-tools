/**
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
 * Handles GNU long name extensions and strips the leading `package/` prefix
 * that npm tarballs use.
 * @param {ArrayBuffer} buffer Raw tar data (already decompressed)
 * @returns {Array<{path: string, data: Uint8Array}>}
 */
export function extractTar(buffer) {
    const view = new Uint8Array(buffer);
    /** @type {Array<{path: string, data: Uint8Array}>} */
    const files = [];
    let offset = 0;

    let longName = '';

    while (offset + 512 <= view.length) {
        // Check for end-of-archive (two consecutive zero blocks)
        let isZero = true;
        for (let i = 0; i < 512; i++) {
            if (view[offset + i] !== 0) { isZero = false; break; }
        }
        if (isZero) break;

        const name = readCString(view, offset, 100);
        const size = parseInt(readCString(view, offset + 124, 12), 8);
        if (isNaN(size) || size < 0) break;

        const type = String.fromCharCode(view[offset + 156]);

        // GNU long name extension
        if (name === '././@LongLink') {
            const data = view.slice(offset + 512, offset + 512 + size);
            longName = new TextDecoder().decode(data).replace(/\0.*$/, '');
            offset += 512 + Math.ceil(size / 512) * 512;
            continue;
        }

        offset += 512;

        if (size === 0 || type === '5') {
            offset += Math.ceil(size / 512) * 512;
            continue;
        }

        const data = view.slice(offset, offset + size);
        offset += Math.ceil(size / 512) * 512;

        const rawPath = longName || name;
        longName = '';

        const path = rawPath.replace(/^package\//, '');
        if (path && !path.startsWith('.') && !path.endsWith('/')) {
            files.push({ path, data });
        }

        if (offset >= view.length) break;
    }

    return files;
}
