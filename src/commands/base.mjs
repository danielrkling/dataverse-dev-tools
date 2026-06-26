export class Command {
  constructor(name, description, aliases = []) {
    this.name = name;
    this.description = description;
    this.aliases = aliases;
  }

  async execute(args, { terminal, fs }) {
    throw new Error("Not implemented");
  }
}
