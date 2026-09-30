import { test, expect } from '@playwright/test';

test.describe('WebFileSystem extension laundering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('writeFile stores .js as .js.$$.mjs on disk', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_write');

      await fs.writeFile('/foo.js', 'export const a = 1;');
      // readdir exposes logical (plain) names even though the on-disk
      // spelling is laundered.
      const logical = await fs.readdir('/');
      // Verify the raw on-disk spelling directly through OPFS.
      const raw = await navigator.storage.getDirectory();
      const dir = await raw.getDirectoryHandle('__test__launder_write');
      const onDisk = [];
      for await (const entry of dir.values()) onDisk.push(entry.name);
      return { logical, onDisk };
    });

    expect(result.logical).toEqual(['foo.js']);
    expect(result.onDisk).toEqual(['foo.js.$$.mjs']);
  });

  test('readFile resolves plain .js path to laundered file', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_read');

      await fs.writeFile('/foo.js', 'export const a = 1;');
      const content = await fs.readFile('/foo.js', { encoding: 'utf8' });
      return content;
    });

    expect(result).toBe('export const a = 1;');
  });

  test('stat and exists work with plain .js path', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_stat');

      await fs.writeFile('/foo.js', 'x');
      const s = await fs.stat('/foo.js');
      const exists = await fs.exists('/foo.js');
      return { type: s.type, exists };
    });

    expect(result).toEqual({ type: 'file', exists: true });
  });

  test('plain .js file on disk wins over laundered twin', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_plain');

      // Simulate a pre-existing plain .js file (e.g. from an older install).
      const raw = await navigator.storage.getDirectory();
      const dir = await raw.getDirectoryHandle('__test__launder_plain', { create: true });
      const plain = await dir.getFileHandle('plain.js', { create: true });
      const w = await plain.createWritable();
      await w.write('plain');
      await w.close();

      await fs.writeFile('/laundered.js', 'laundered');
      return {
        plain: await fs.readFile('/plain.js', { encoding: 'utf8' }),
        laundered: await fs.readFile('/laundered.js', { encoding: 'utf8' }),
      };
    });

    expect(result).toEqual({ plain: 'plain', laundered: 'laundered' });
  });

  test('unlink removes the laundered file via plain path', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_unlink');

      await fs.writeFile('/foo.js', 'x');
      await fs.unlink('/foo.js');
      return await fs.readdir('/');
    });

    expect(result).toEqual([]);
  });

  test('rename writes the target laundered', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_rename');

      await fs.writeFile('/a.js', 'moved');
      await fs.rename('/a.js', '/b.js');
      return {
        content: await fs.readFile('/b.js', { encoding: 'utf8' }),
        listing: (await fs.readdir('/')).sort(),
      };
    });

    expect(result).toEqual({
      content: 'moved',
      listing: ['b.js'],
    });
  });

  test('laundering can be disabled per instance', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { WebFileSystem } = await import('/src/services/fs.mjs');
      const fs = await WebFileSystem.fromOPFS('__test__launder_off');
      fs.launderExtensions = false;

      await fs.writeFile('/foo.js', 'plain js');
      return {
        listing: await fs.readdir('/'),
        content: await fs.readFile('/foo.js', { encoding: 'utf8' }),
      };
    });

    expect(result).toEqual({ listing: ['foo.js'], content: 'plain js' });
  });
});
