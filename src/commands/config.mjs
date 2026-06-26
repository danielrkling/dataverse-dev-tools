import { Command, register } from "./index.mjs";

class ConfigCommand extends Command {
  constructor() {
    super("config", "Manage configuration (placeholder)", ["cfg"]);
  }

  async execute(args, { terminal, fs }) {
    return "Config command is not yet implemented.";
  }
}

register(new ConfigCommand());
