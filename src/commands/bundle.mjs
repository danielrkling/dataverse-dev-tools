import { Command, register } from "./index.mjs";

class BundleCommand extends Command {
  constructor() {
    super("bundle", "Bundle a file (placeholder)", ["build"]);
  }

  async execute(args, { terminal, fs }) {
    return "Bundle command is not yet implemented.";
  }
}

register(new BundleCommand());
