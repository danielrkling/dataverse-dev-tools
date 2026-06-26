import { Command, register } from "./index.mjs";

class NpmCommand extends Command {
  constructor() {
    super("npm", "Download packages from npm (placeholder)", ["install-pkg"]);
  }

  async execute(args, { terminal, fs }) {
    return "NPM command is not yet implemented.";
  }
}

register(new NpmCommand());
