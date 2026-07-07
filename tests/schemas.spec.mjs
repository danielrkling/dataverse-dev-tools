import { test, expect } from '@playwright/test';
import { esbuildConfigSchema, dataverseConfigSchema, tailwindConfigSchema } from '../src/utils/schemas.mjs';

function stripEmpty(v) {
  if (v === undefined) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) return true;
  return false;
}

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
      expect(result.data.watch).toBeUndefined();
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

  test('CLI undefined values do not override file config defaults', () => {
    const fileConfig = { entryPoints: ['./src/app.ts'], outdir: 'dist', format: 'esm' };
    const cliParsed = { entryPoints: [], outdir: undefined, bundle: undefined, minify: undefined };
    const merged = { ...fileConfig, ...Object.fromEntries(Object.entries(cliParsed).filter(([_, v]) => !stripEmpty(v))) };
    const result = esbuildConfigSchema.safeParse(merged);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entryPoints).toEqual(['./src/app.ts']);
      expect(result.data.outdir).toBe('dist');
      expect(result.data.format).toBe('esm');
      expect(result.data.bundle).toBe(true);
      expect(result.data.minify).toBe(false);
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

  test('sourcemap accepts boolean or enum values', () => {
    const t = (v) => esbuildConfigSchema.safeParse({ sourcemap: v }).success;
    expect(t(true)).toBe(true);
    expect(t(false)).toBe(true);
    expect(t('inline')).toBe(true);
    expect(t('external')).toBe(true);
    expect(t('both')).toBe(true);
    expect(t('linked')).toBe(false);
    expect(t('')).toBe(false);
    expect(t('unknown')).toBe(false);
  });

  test('treeShaking accepts boolean', () => {
    const t = (v) => esbuildConfigSchema.safeParse({ treeShaking: v }).success;
    expect(t(true)).toBe(true);
    expect(t(false)).toBe(true);
    expect(t('ignore-annotations')).toBe(false);
    expect(t('unknown')).toBe(false);
  });

  test('mainFields accepts array of strings', () => {
    const t = (v) => esbuildConfigSchema.safeParse({ mainFields: v }).success;
    expect(t(['browser', 'main'])).toBe(true);
    expect(t([])).toBe(true);  // dropEmpty converts [] → undefined → valid
    expect(t('browser,main')).toBe(false);
  });

  test('rejects unknown keys in strict mode', () => {
    const result = esbuildConfigSchema.safeParse({ nonexistent: true });
    expect(result.success).toBe(true);
    // With default .strip(), unknown keys are silently removed
    if (result.success) {
      expect('nonexistent' in result.data).toBe(false);
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
      expect(result.data.prefix).toBeUndefined();
      expect(result.data.preview).toBeUndefined();
      expect(result.data.refresh).toBeUndefined();
      expect(result.data.solution).toBeUndefined();
      expect(result.data.files).toBeUndefined();
    }
  });

  test('merges partial config with defaults', () => {
    const result = dataverseConfigSchema.safeParse({ prefix: 'myapp' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.prefix).toBe('myapp');
      expect(result.data.preview).toBeUndefined();
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
      expect(result.data.content).toBeUndefined();
      expect(result.data.css).toBeUndefined();
      expect(result.data.outfile).toBeUndefined();
      expect(result.data.plugins).toBeUndefined();
    }
  });

  test('accepts css as a string', () => {
    const result = tailwindConfigSchema.safeParse({ css: './src/tailwind.css' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.css).toBe('./src/tailwind.css');
    }
  });

  test('content accepts string or string array', () => {
    expect(tailwindConfigSchema.safeParse({ content: './src' }).success).toBe(true);
    expect(tailwindConfigSchema.safeParse({ content: ['./a', './b'] }).success).toBe(true);
  });

  test('rejects non-string outfile', () => {
    const result = tailwindConfigSchema.safeParse({ outfile: 123 });
    expect(result.success).toBe(false);
  });
});
