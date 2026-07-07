import { test, expect } from '@playwright/test';
import { dirname, join, normalize } from '../src/utils/path.mjs';

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
    test('returns jsx for javascript content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return [getLoaderFromContentType('text/javascript', ''), getLoaderFromContentType('application/javascript', '')];
        });
        expect(result).toEqual(['jsx', 'jsx']);
    });

    test('returns jsx for typescript content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return getLoaderFromContentType('text/typescript', '');
        });
        expect(result).toBe('jsx');
    });

    test('returns css for css content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return getLoaderFromContentType('text/css', '');
        });
        expect(result).toBe('css');
    });

    test('returns json for json content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return getLoaderFromContentType('application/json', '');
        });
        expect(result).toBe('json');
    });

    test('returns text for text content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return getLoaderFromContentType('text/plain', '');
        });
        expect(result).toBe('text');
    });

    test('defaults loader based on URL extension when content type is empty', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return [getLoaderFromContentType('', 'file.js'), getLoaderFromContentType('', 'file.ts'), getLoaderFromContentType('', 'file.css'), getLoaderFromContentType('', 'file.json')];
        });
        expect(result).toEqual(['js', 'js', 'css', 'json']);
    });

    test('returns text for unknown content type', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { getLoaderFromContentType } = await import('../src/utils/esbuild.mjs');
            return getLoaderFromContentType('application/octet-stream', '');
        });
        expect(result).toBe('text');
    });
});

test.describe('fsPlugin', () => {
    test('returns a valid esbuild plugin', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { fsPlugin } = await import('../src/utils/esbuild.mjs');
            const plugin = fsPlugin({});
            return { name: plugin.name, hasSetup: typeof plugin.setup === 'function' };
        });
        expect(result.name).toBe('browser-fs');
        expect(result.hasSetup).toBe(true);
    });

    test('accepts an external config', async ({ page }) => {
        await page.goto('/');
        const result = await page.evaluate(async () => {
            const { fsPlugin } = await import('../src/utils/esbuild.mjs');
            const plugin = fsPlugin({}, { external: ['react'] });
            return plugin.name;
        });
        expect(result).toBe('browser-fs');
    });
});
