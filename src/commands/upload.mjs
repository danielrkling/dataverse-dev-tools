import { uploadWebResource, publishWebResources } from '../wr.mjs';

/** @type {import('../plugin.mjs').Plugin} */
export default {
  name: 'upload',
  commands: [
    {
      name: 'upload',
      aliases: ['ul'],
      description: 'Upload a web resource to Dataverse',
      usage: 'upload <path>',
      /** @param {string[]} args @param {import('../terminal.mjs').WebTerminal} term @param {import('../plugin.mjs').ExecuteContext} ctx */
      handler: async (args, term, { fs }) => {
        if (!args[0]) return 'Usage: upload <path>';
        const path = args[0];
        let prefix = '';
        let solution;
        try {
          const raw = await fs.readFile('dataverse.config.json', { encoding: 'utf8' });
          const config = JSON.parse(/** @type {string} */ (raw));
          prefix = config.upload?.prefix || '';
          solution = config.upload?.solution || undefined;
        } catch {
          // no config — prefix stays empty
        }
        if (!prefix) {
          return 'No prefix configured. Set upload.prefix in dataverse.config.json or include the full web resource name in the path.';
        }
        const name = `${prefix}${path.startsWith("/") ? "" : "/"}${path}`;
        term.log(`Uploading ${name}...`);
        try {
          const wr = await uploadWebResource(
            name,
            /** @type {string} */ (await fs.readFile(path, { encoding: 'utf8' })),
            solution,
          );
          term.log(`Uploaded ${name}`);
          await publishWebResources(
            [wr].filter(/** @return {wr is import('../wr.mjs').WebResource} */ (wr) => wr != null),
            solution,
          );
          return `Published ${name}`;
        } catch (e) {
          return `Upload failed: ${e.message}`;
        }
      },
    },
  ],
};
