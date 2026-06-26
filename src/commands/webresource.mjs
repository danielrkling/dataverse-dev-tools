import { Command, register } from "./index.mjs";
import {
  getWebResources,
  getWebResource,
  uploadWebResource,
  deleteWebResource,
  publishWebResources,
  getSolutions,
  isValidWebResource,
} from "../web-resource.mjs";

class WrListCommand extends Command {
  constructor() {
    super("wr-list", "List web resources in Dataverse", ["ls-wr"]);
  }

  async execute(args, { terminal, fs }) {
    const root = args[1] || "";
    const resources = await getWebResources(root);
    if (resources.length === 0) return "No web resources found.";
    return resources
      .map((r) => {
        const type = r.webresourcetype;
        const icon = type === 1 ? "[html]" : type === 2 ? "[css]" : type === 3 ? "[js]" : "[file]";
        return `${icon} ${r.name} (${r.webresourceid})`;
      })
      .join("\n");
  }
}

class WrGetCommand extends Command {
  constructor() {
    super("wr-get", "Get a web resource from Dataverse", ["cat-wr"]);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("wr-get: missing name operand");
    const wr = await getWebResource(args[1]);
    if (!wr) return `Web resource '${args[1]}' not found.`;
    const text = atob(wr.content);
    return text;
  }
}

class WrUploadCommand extends Command {
  constructor() {
    super("wr-upload", "Upload local file to Dataverse as web resource", ["push"]);
  }

  async execute(args, { terminal, fs }) {
    const source = args[1];
    const target = args[2];
    const solution = args[3];
    if (!source) throw new Error("wr-upload: missing source file operand");

    const stat = await fs.stat(source);
    if (stat.isDirectory) throw new Error(`wr-upload: ${source} is a directory`);

    const content = await fs.readFile(source, { encoding: "utf8" });
    const name = target || source.replace(/^\//, "");

    if (!isValidWebResource(name)) {
      return `Invalid web resource name: '${name}'. Must start with a letter and have a known extension.`;
    }

    const result = await uploadWebResource(name, content, solution);
    return result
      ? `Uploaded '${name}' successfully. ID: ${result.webresourceid ?? "new"}`
      : `Upload failed for '${name}'.`;
  }
}

class WrDeleteCommand extends Command {
  constructor() {
    super("wr-delete", "Delete a web resource from Dataverse", ["rm-wr"]);
  }

  async execute(args, { terminal, fs }) {
    if (!args[1]) throw new Error("wr-delete: missing name operand");
    await deleteWebResource(args[1]);
    return `Deleted '${args[1]}'.`;
  }
}

class WrPublishCommand extends Command {
  constructor() {
    super("wr-publish", "Publish web resources", ["pub"]);
  }

  async execute(args, { terminal, fs }) {
    const names = args.slice(1);
    if (names.length === 0) throw new Error("wr-publish: missing name operand(s)");
    const resources = [];
    for (const name of names) {
      const wr = await getWebResource(name);
      if (wr) resources.push(wr);
    }
    await publishWebResources(resources);
    return `Published ${resources.length} web resource(s).`;
  }
}

class WrPublishAllCommand extends Command {
  constructor() {
    super("wr-publish-all", "Publish all web resources under a prefix", ["pub-all"]);
  }

  async execute(args, { terminal, fs }) {
    const root = args[1] || "";
    const resources = await getWebResources(root);
    await publishWebResources(resources);
    return `Published ${resources.length} web resource(s) under '${root}'.`;
  }
}

class WrSolutionsCommand extends Command {
  constructor() {
    super("wr-solutions", "List unmanaged solutions", ["solutions"]);
  }

  async execute(args, { terminal, fs }) {
    const solutions = await getSolutions();
    if (solutions.length === 0) return "No unmanaged solutions found.";
    return solutions.map((s) => `${s.friendlyname} (${s.uniquename})`).join("\n");
  }
}

register(new WrListCommand());
register(new WrGetCommand());
register(new WrUploadCommand());
register(new WrDeleteCommand());
register(new WrPublishCommand());
register(new WrPublishAllCommand());
register(new WrSolutionsCommand());
