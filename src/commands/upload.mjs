import { uploadWebResource, publishWebResources, isValidWebResource } from '../wr.mjs';
import { Plugin } from '../plugin.mjs';
import { readJSON } from '../utils/json.mjs';

export default class UploadPlugin extends Plugin {
  get name() { return 'upload' }
  get commands() {
    return [
      {
        name: 'upload',
        aliases: ['ul'],
        description: 'Upload web resources to Dataverse',
        usage: 'upload <path> [--publish]',
        /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
        handler: async (args, term, { fs }) => {
          if (!args[0]) return 'Usage: upload <path> [--publish]';
          const rawPath = args[0];
          const publishImmediately = args.includes('--publish');

          const config = await readJSON(fs, 'dataverse.config.json');
          const prefix = config?.upload?.prefix || '';
          const solution = config?.upload?.solution || undefined;

          if (!prefix) {
            return 'No prefix configured. Set upload.prefix in dataverse.config.json or include the full web resource name in the path.';
          }

          let files;
          try {
            const stat = await fs.stat(rawPath);
            if (stat.isDirectory) {
              const entries = await fs.getFilesFromDirectory(rawPath);
              files = Object.entries(entries);
            } else {
              const content = await fs.readFile(rawPath, { encoding: 'utf8' });
              files = [[rawPath, content]];
            }
          } catch {
            return `upload: cannot read '${rawPath}'`;
          }

          const valid = [];
          const lines = new Map();

          for (const [path, content] of files) {
            const name = `${prefix}${path.startsWith("/") ? "" : "/"}${path}`;
            if (!isValidWebResource(name)) {
              const line = term.log(`${name} — <span style="color:#888">○ skipped (invalid web resource name)</span>`);
              lines.set(path, line);
              continue;
            }
            valid.push([path, name, content]);
          }

          if (valid.length === 0) return 'No valid web resources to upload.';
          term.log(`Found ${valid.length} file(s) to upload`);

          const results = await Promise.allSettled(
            valid.map(async ([path, name, content]) => {
              const line = lines.get(path) || term.log(`${name} — ○ uploading...`);
              try {
                line.innerHTML = `${name} — <span style="color:#569cd6">● uploading...</span>`;
                const wr = await uploadWebResource(name, content, solution);
                line.innerHTML = `${name} — <span style="color:#4ec9b0">● uploaded</span>`;
                return wr;
              } catch (e) {
                line.innerHTML = `${name} — <span style="color:#f48771">✖ failed: ${e.message}</span>`;
                return undefined;
              }
            }),
          );

          const validWrs = results
            .map(r => r.status === 'fulfilled' ? r.value : undefined)
            .filter(wr => wr != null);

          if (validWrs.length === 0) return 'All uploads failed.';

          if (publishImmediately) {
            for (const [, name] of valid) {
              const line = lines.get(name);
              if (line && !line.innerHTML.includes('✖')) {
                line.innerHTML = `${name} — <span style="color:#569cd6">● publishing...</span>`;
              }
            }
            try {
              await publishWebResources(validWrs, solution);
              for (const [, name] of valid) {
                const line = lines.get(name);
                if (line && !line.innerHTML.includes('✖')) {
                  line.innerHTML = `${name} — <span style="color:#569cd6">● published</span>`;
                }
              }
              return `${validWrs.length} file(s) published.`;
            } catch (e) {
              return `Publish failed: ${e.message}`;
            }
          }

          return `${validWrs.length} file(s) uploaded. Use --publish to publish immediately or wait for the watcher.`;
        },
      },
    ];
  }
  /** @param {import('../plugin.mjs').InitContext} ctx */
  async init({ fs, pm, terminal: term }) {
    const config = await readJSON(fs, 'dataverse.config.json');
    if (!config) return;
    const upload = config.upload;
    if (!upload?.prefix || !upload?.watch) return;

    /** @type {Array<{path: string, name: string, content: string}>} */
    let publishQueue = [];
    let publishTimer = null;

    async function flushPublish() {
      const batch = publishQueue;
      publishQueue = [];
      publishTimer = null;
      if (batch.length === 0) return;

      for (const item of batch) {
        const line = item.line;
        if (line) line.innerHTML = `${item.name} — <span style="color:#569cd6">● publishing...</span>`;
      }

      const wrIds = batch.map(i => i.wr).filter(Boolean);
      try {
        await publishWebResources(wrIds, upload.solution || undefined);
        for (const item of batch) {
          if (item.line && !item.line.innerHTML.includes('✖')) {
            item.line.innerHTML = `${item.name} — <span style="color:#569cd6">● published</span>`;
          }
        }
        pm.emit('publish:complete', { files: batch.map(i => [i.path, i.content]) });
        if (upload.refresh === "onPublish") pm.emit('preview:refresh', {});
      } catch (e) {
        term.error(`Publish failed: ${e.message}`);
        pm.emit('publish:error', { error: e.message });
      }
    }

    /** @param {Array<[string, string]>} filesToUpload */
    const uploadFiles = async (filesToUpload) => {
      if (filesToUpload.length === 0) return;

      const valid = [];
      for (const [path, content] of filesToUpload) {
        const name = `${upload.prefix}${path.startsWith("/") ? "" : "/"}${path}`;
        if (!isValidWebResource(name)) continue;
        const line = term.log(`${name} — ○ queued`);
        valid.push({ path, name, content, line });
      }
      if (valid.length === 0) return;

      await Promise.allSettled(
        valid.map(async (item) => {
          try {
            item.line.innerHTML = `${item.name} — <span style="color:#569cd6">● uploading...</span>`;
            const wr = await uploadWebResource(item.name, item.content, upload.solution);
            item.wr = wr;
            item.line.innerHTML = `${item.name} — <span style="color:#4ec9b0">● uploaded</span>`;
            return wr;
          } catch (e) {
            item.line.innerHTML = `${item.name} — <span style="color:#f48771">✖ failed: ${e.message}</span>`;
            return undefined;
          }
        }),
      );

      const uploaded = valid.filter(i => i.wr);
      if (uploaded.length === 0) return;

      pm.emit('upload:complete', { files: filesToUpload, webResources: uploaded.map(i => i.wr) });
      if (upload.refresh === "onUpload") pm.emit('preview:refresh', {});

      publishQueue.push(...uploaded);
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = setTimeout(flushPublish, 1000);
    };

    const unsub = pm.on('fs:change', ({ path, type }) => {
      if (type !== 'modified') return;
      if (!upload.watch.some(dir => path.startsWith(dir))) return;

      const name = `${upload.prefix}${path.startsWith("/") ? "" : "/"}${path}`;
      if (!isValidWebResource(name)) return;

      fs.readFile(path)
        .then(content => {
          const str = typeof content === 'string' ? content : new TextDecoder().decode(content);
          uploadFiles([[path, str]]);
        })
        .catch(() => {});
    });

    for (const watch of upload.watch) {
      try {
        const files = await fs.getFilesFromDirectory(watch);
        uploadFiles(Object.entries(files));
      } catch {}
    }

    return () => {
      unsub();
      if (publishTimer) clearTimeout(publishTimer);
      if (publishQueue.length > 0) flushPublish();
    };
  }
}
