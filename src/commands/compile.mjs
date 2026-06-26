import { Command, register } from "./index.mjs";

class CompileCommand extends Command {
  constructor() {
    super("compile", "Compile TypeScript (placeholder)", ["tsc", "ts"]);
  }

  async execute(args, { terminal, fs }) {
    return "Compile command is not yet implemented.";
  }
}

register(new CompileCommand());
