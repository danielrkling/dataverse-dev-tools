import { test, expect } from '@playwright/test';
import { dirname, join, normalize } from '../src/utils/path.mjs';
import { getLoaderFromContentType, fsPlugin } from '../src/commands/esbuild.mjs';

test.describe('path helpers', () => {
    test('dirname extracts parent directory', () => {
        expect(dirname('a/b/c')).toBe('a/b');
        expect(dirname('a/b')).toBe('a');
        expect(dirname('a')).toBe('');
        expect(dirname('')).toBe('');
    });

    test('join combines path segments', () => {
        expect(join('a', 'b', 'c')).toBe('a/b/c');
        expect(join('a/', '/b/', '/c')).toBe('a/b/c');
        expect(join('a', '..', 'b')).toBe('b');
        expect(join('.', 'a', '.', 'b')).toBe('a/b');
    });

    test('normalize cleans up paths', () => {
        expect(normalize('a/b/c')).toBe('a/b/c');
        expect(normalize('a/./b/../c')).toBe('a/c');
        expect(normalize('./a/b')).toBe('a/b');
        expect(normalize('a//b///c')).toBe('a/b/c');
    });

    test('dirname extracts parent from absolute-style path', () => {
        expect(dirname('a/b/c.ts')).toBe('a/b');
        expect(dirname('file.ts')).toBe('');
        expect(dirname('a/b/c/d.ts')).toBe('a/b/c');
    });

    test('normalize resolves dot segments', () => {
        expect(normalize('a/b/../c')).toBe('a/c');
        expect(normalize('a/./b')).toBe('a/b');
        expect(normalize('a/b/c/../../d')).toBe('a/d');
    });
});

test.describe('getLoaderFromContentType', () => {
    test('returns jsx for javascript content type', () => {
        expect(getLoaderFromContentType('text/javascript', '')).toBe('jsx');
        expect(getLoaderFromContentType('application/javascript', '')).toBe('jsx');
    });

    test('returns jsx for typescript content type', () => {
        expect(getLoaderFromContentType('text/typescript', '')).toBe('jsx');
    });

    test('returns css for css content type', () => {
        expect(getLoaderFromContentType('text/css', '')).toBe('css');
    });

    test('returns json for json content type', () => {
        expect(getLoaderFromContentType('application/json', '')).toBe('json');
    });

    test('returns text for text content type', () => {
        expect(getLoaderFromContentType('text/plain', '')).toBe('text');
    });

    test('defaults loader based on URL extension when content type is empty', () => {
        expect(getLoaderFromContentType('', 'file.js')).toBe('js');
        expect(getLoaderFromContentType('', 'file.ts')).toBe('js');
        expect(getLoaderFromContentType('', 'file.css')).toBe('css');
        expect(getLoaderFromContentType('', 'file.json')).toBe('json');
    });

    test('returns text for unknown content type', () => {
        expect(getLoaderFromContentType('application/octet-stream', '')).toBe('text');
    });
});

test.describe('fsPlugin', () => {
    test('returns a valid esbuild plugin', () => {
        const plugin = fsPlugin(/** @type {any} */ ({}));
        expect(plugin.name).toBe('browser-fs');
        expect(typeof plugin.setup).toBe('function');
    });

    test('accepts an external config', () => {
        const plugin = fsPlugin(/** @type {any} */ ({}), { external: ['react'] });
        expect(plugin.name).toBe('browser-fs');
    });
});
