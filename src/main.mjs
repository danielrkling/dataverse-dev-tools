import { clear, help } from "./commands/builtin.mjs";
import { flatten } from "./commands/flatten.mjs";
import {
  lsCommand,
  catCommand,
  cdCommand,
  mvCommand,
  rmCommand,
  pwdCommand,
  statCommand,
  mkdirCommand,
  touchCommand,
} from "./commands/fs.mjs";
import { initConfig } from "./commands/init-config.mjs";
import { npmCommand } from "./commands/npm.mjs";
import { previewCommand } from "./commands/preview.mjs";
import { runCommand } from "./commands/run.mjs";
import { WebTerminal } from "./terminal.mjs";


/** @type {WebTerminal} */
export const terminal = /** @type {WebTerminal} */ (
  document.querySelector("web-terminal")
);

terminal.registerCommand(help);
terminal.registerCommand(clear);
terminal.registerCommand(flatten);
terminal.registerCommand(lsCommand);
terminal.registerCommand(catCommand);
terminal.registerCommand(cdCommand);
terminal.registerCommand(mvCommand);
terminal.registerCommand(rmCommand);
terminal.registerCommand(pwdCommand);
terminal.registerCommand(statCommand);
terminal.registerCommand(mkdirCommand);
terminal.registerCommand(touchCommand);
terminal.registerCommand(initConfig)
terminal.registerCommand(previewCommand);
terminal.registerCommand(npmCommand)
terminal.registerCommand(runCommand)
