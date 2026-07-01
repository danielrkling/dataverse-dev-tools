import { runParserSync } from '@optique/core';

/**
 * Parses arguments for a command using an Optique parser.
 * Logs help or errors to the terminal if parsing fails.
 *
 * @param {any} parser - The Optique parser schema.
 * @param {string} commandName - The name of the command.
 * @param {string[]} args - The arguments array to parse.
 * @param {import('../terminal.mjs').WebTerminal} term - The terminal to log to.
 * @param {any} [options] - Additional options (brief, description, etc.)
 * @returns {any | null} The parsed options object, or null if help was shown or parsing failed.
 */
export function parseCommandArgs(parser, commandName, args, term, options = {}) {
  try {
    return runParserSync(parser, commandName, args, {
      help: {
        option: true,
        onShow: () => {
          throw new Error('HELP_SHOWN');
        }
      },
      brief: options.brief,
      description: options.description,
      stdout: (msg) => term.log(msg),
      stderr: (msg) => term.log(msg, { class: 'log-error' }),
      onError: () => {
        throw new Error('PARSING_FAILED');
      }
    });
  } catch (e) {
    if (e.message === 'HELP_SHOWN' || e.message === 'PARSING_FAILED') {
      return null;
    }
    throw e;
  }
}
