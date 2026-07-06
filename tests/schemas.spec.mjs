import { test, expect } from '@playwright/test';
import { esbuildConfigSchema, dataverseConfigSchema, tailwindConfigSchema } from '../src/utils/schemas.mjs';

test.describe('esbuildConfigSchema', () => {
  test('validates a full esbuild config', () => {
    const config = {
      entryPoints: ['./src/app.ts'],
      outdir: 'dist',
      minify: false,
      format: 'esm',
      platform: 'browser',
      sourcemap: 'inline',
      splitting: false,
      outExtension: { '.js': '.mjs' },
    };
    const result = esbuildConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoints).toEqual(['./src/app.ts']);
      expect(result.data.outdir).toBe('dist');
    }
  });

  test('fills defaults for empty config', () => {
    const result = esbuildConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoints).toEqual(['./src/app.ts']);
      expect(result.data.outdir).toBe('dist');
      expect(result.data.minify).toBe(false);
      expect(result.data.bundle).toBe(true);
      expect(result.data.format).toBe('esm');
      expect(result.data.platform).toBe('browser');
      expect(result.data.sourcemap).toBe('inline');
      expect(result.data.splitting).toBe(false);
      expect(result.data.outExtension).toEqual({ '.js': '.mjs' });
      expect(result.data.watch).toEqual(['src']);
    }
  });

  test('merges partial config with defaults', () => {
    const result = esbuildConfigSchema.safeParse({ entryPoints: ['./src/main.ts'], format: 'cjs' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoints).toEqual(['./src/main.ts']);
      expect(result.data.format).toBe('cjs');
      expect(result.data.outdir).toBe('dist');
    }
  });

  test('CLI empty values do not override file config defaults', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'], outdir: 'dist', format: 'esm' };
    const cliParsed = { entryPoints: [], outdir: undefined, bundle: undefined, define: {}, watch: [] };
    const merged = { ...fileConfig, ...cliParsed };
    const result = esbuildConfigSchema.safeParse(merged);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoints).toEqual(['./src/app.ts']);
      expect(result.data.outdir).toBe('dist');
      expect(result.data.format).toBe('esm');
      expect(result.data.bundle).toBe(true);
      expect(result.data.watch).toEqual(['src']);
    }
  });

  test('rejects invalid format', () => {
    const result = esbuildConfigSchema.safeParse({ format: 'invalid' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid platform', () => {
    const result = esbuildConfigSchema.safeParse({ platform: 'ios' });
    expect(result.success).toBe(false);
  });

  test('passes through unknown keys', () => {
    const result = esbuildConfigSchema.safeParse({ inject: ['./polyfill.js'] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.inject).toEqual(['./polyfill.js']);
    }
  });
});

test.describe('dataverseConfigSchema', () => {
  test('validates a full dataverse config', () => {
    const config = {
      prefix: 'myapp',
      preview: 'index.html',
      refresh: 'onUpload',
      solution: 'MySolution',
      files: ['src/**/*.js', 'dist/**/*.css'],
    };
    const result = dataverseConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prefix).toBe('myapp');
      expect(result.data.files).toEqual(['src/**/*.js', 'dist/**/*.css']);
    }
  });

  test('fills defaults for empty config', () => {
    const result = dataverseConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prefix).toBe('');
      expect(result.data.preview).toBe('index.html');
      expect(result.data.refresh).toBe('onUpload');
      expect(result.data.solution).toBe('');
      expect(result.data.files).toEqual([]);
    }
  });

  test('merges partial config with defaults', () => {
    const result = dataverseConfigSchema.safeParse({ prefix: 'myapp' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prefix).toBe('myapp');
      expect(result.data.preview).toBe('index.html');
    }
  });

  test('rejects non-string prefix', () => {
    const result = dataverseConfigSchema.safeParse({ prefix: 123 });
    expect(result.success).toBe(false);
  });

  test('rejects non-array files', () => {
    const result = dataverseConfigSchema.safeParse({ files: 'src/**/*.js' });
    expect(result.success).toBe(false);
  });
});

test.describe('tailwindConfigSchema', () => {
  test('validates a full tailwind config', () => {
    const config = {
      content: ['./src', './index.html'],
      extensions: ['html', 'js', 'ts'],
      css: ['@import "tailwindcss"', './src/custom.css'],
      outfile: './dist/tailwind.css',
      plugins: ['@tailwindcss/typography'],
    };
    const result = tailwindConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toEqual(['./src', './index.html']);
      expect(result.data.plugins).toEqual(['@tailwindcss/typography']);
    }
  });

  test('fills defaults for empty config', () => {
    const result = tailwindConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.content).toEqual(['./src']);
      expect(result.data.extensions).toEqual(['html', 'js', 'ts', 'jsx', 'tsx', 'mjs']);
      expect(result.data.css).toEqual(['@import "tailwindcss"']);
      expect(result.data.outfile).toBe('./dist/tailwind.css');
      expect(result.data.plugins).toEqual([]);
    }
  });

  test('accepts css as a string', () => {
    const result = tailwindConfigSchema.safeParse({ css: './src/tailwind.css' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.css).toBe('./src/tailwind.css');
    }
  });

  test('rejects non-array content', () => {
    const result = tailwindConfigSchema.safeParse({ content: './src' });
    expect(result.success).toBe(false);
  });

  test('rejects non-string outfile', () => {
    const result = tailwindConfigSchema.safeParse({ outfile: 123 });
    expect(result.success).toBe(false);
  });
});
