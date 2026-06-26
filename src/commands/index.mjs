import { Command } from "./base.mjs";

const COMMANDS = new Map();
const ALIAS_MAP = new Map();
const MODULES = new Map();

export function register(cmd) {
  COMMANDS.set(cmd.name, cmd);
  for (const alias of cmd.aliases) {
    ALIAS_MAP.set(alias, cmd.name);
  }
}

export function get(name) {
  const resolved = ALIAS_MAP.get(name) || name;
  return COMMANDS.get(resolved);
}

export function all() {
  return Array.from(COMMANDS.values());
}

export function has(name) {
  return COMMANDS.has(name) || ALIAS_MAP.has(name);
}

export function lazy(modulePath, names) {
  for (const name of names) {
    MODULES.set(name, modulePath);
    for (const alias of names) {
      if (alias !== name) {
        MODULES.set(alias, modulePath);
      }
    }
  }
}

export async function load(name) {
  const resolved = ALIAS_MAP.get(name) || name;
  if (COMMANDS.has(resolved)) return true;

  const modulePath = MODULES.get(resolved);
  if (!modulePath) return false;

  await import(modulePath);
  return COMMANDS.has(resolved);
}

export function getModulePath(name) {
  return MODULES.get(name);
}

export { Command };
