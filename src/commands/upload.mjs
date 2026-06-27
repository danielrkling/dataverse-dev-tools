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
        if (!fs) return 'No file system.';
        if (!args[0]) return 'Usage: upload <path>';
        const path = args[0];
        term.log(`Uploading ${path}...`);
        try {
          const wr = await uploadWebResource(
            `Dev_Tools/${path}`,
            /** @type {string} */ (await fs.readFile(path, { encoding: 'utf8' })),
            'NNSY_Dev_Tools',
          );
          term.log(`Uploaded ${path}`);
          await publishWebResources([wr].filter(/** @return {wr is import('../wr.mjs').WebResource} */ (wr) => wr != null));
          return `Published ${path}`;
        } catch (e) {
          return `Upload failed: ${e.message}`;
        }
      },
    },
  ],
};
