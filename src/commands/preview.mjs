import { Command, register } from "./index.mjs";

class PreviewCommand extends Command {
  constructor() {
    super("preview", "Preview a file (placeholder)", ["serve"]);
  }

  async execute(args, { terminal, fs }) {
    return "Preview command is not yet implemented.";
  }
}

register(new PreviewCommand());
