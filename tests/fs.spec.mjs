import { test, expect } from '@playwright/test';

test.describe('WebFileSystem on OPFS', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('fromOPFS creates a working file system', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__dataverse');

      await fs.writeFile('/hello.txt', 'Hello OPFS!');
      const content = await fs.readFile('/hello.txt', { encoding: 'utf8' });
      return content;
    });

    expect(result).toBe('Hello OPFS!');
  });

  test('writeFile and readFile roundtrip', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__roundtrip');

      await fs.writeFile('/test.json', JSON.stringify({ a: 1, b: [2, 3] }));
      const raw = await fs.readFile('/test.json', { encoding: 'utf8' });
      return JSON.parse(raw);
    });

    expect(result).toEqual({ a: 1, b: [2, 3] });
  });

  test('readdir lists directory contents', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__readdir');

      await fs.writeFile('/a.txt', 'a');
      await fs.writeFile('/b.txt', 'b');
      await fs.mkdir('/sub');
      await fs.writeFile('/sub/c.txt', 'c');

      const root = await fs.readdir('/');
      return root.sort();
    });

    expect(result).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  test('mkdir creates directories', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__mkdir');

      await fs.mkdir('/a/b/c', { recursive: true });
      await fs.writeFile('/a/b/c/file.txt', 'deep');
      return await fs.readFile('/a/b/c/file.txt', { encoding: 'utf8' });
    });

    expect(result).toBe('deep');
  });

  test('unlink removes a file', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__unlink');

      await fs.writeFile('/toremove.txt', 'delete me');
      await fs.unlink('/toremove.txt');

      try {
        await fs.readFile('/toremove.txt');
        return 'exists';
      } catch {
        return 'removed';
      }
    });

    expect(result).toBe('removed');
  });

  test('rmdir removes a directory', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__rmdir');

      await fs.mkdir('/emptydir');
      await fs.rmdir('/emptydir');

      try {
        await fs.readdir('/emptydir');
        return 'exists';
      } catch {
        return 'removed';
      }
    });

    expect(result).toBe('removed');
  });

  test('stat returns file metadata', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__stat');

      await fs.writeFile('/stats.txt', '12345');
      const s = await fs.stat('/stats.txt');

      return {
        isFile: s.isFile,
        isDirectory: s.isDirectory,
        size: s.size,
        mtimeMs: s.mtimeMs > 0,
      };
    });

    expect(result).toEqual({
      isFile: true,
      isDirectory: false,
      size: 5,
      mtimeMs: true,
    });
  });

  test('stat returns directory info', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__statdir');

      await fs.mkdir('/mydir');
      const s = await fs.stat('/mydir');

      return { isFile: s.isFile, isDirectory: s.isDirectory };
    });

    expect(result).toEqual({ isFile: false, isDirectory: true });
  });

  test('cd changes working directory', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__cd');

      await fs.mkdir('/subdir');
      const cwd = await fs.cd('/subdir');
      return cwd;
    });

    expect(result).toBe('/subdir');
  });

  test('exists returns true for existing files', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__exists');

      await fs.writeFile('/present.txt', 'here');
      const exists = await fs.exists('/present.txt');
      const missing = await fs.exists('/missing.txt');
      return { exists, missing };
    });

    expect(result).toEqual({ exists: true, missing: false });
  });

  test('readFile binary returns ArrayBuffer', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__binary');

      await fs.writeFile('/data.bin', new Uint8Array([0, 1, 2, 255]));
      const buf = await fs.readFile('/data.bin');
      const view = new Uint8Array(buf);
      return [...view];
    });

    expect(result).toEqual([0, 1, 2, 255]);
  });

  test('rename moves a file', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__rename');

      await fs.writeFile('/original.txt', 'moved content');
      await fs.rename('/original.txt', '/moved.txt');

      const movedContent = await fs.readFile('/moved.txt', { encoding: 'utf8' });
      const originalExists = await fs.exists('/original.txt');
      return { movedContent, originalExists };
    });

    expect(result).toEqual({ movedContent: 'moved content', originalExists: false });
  });
});
