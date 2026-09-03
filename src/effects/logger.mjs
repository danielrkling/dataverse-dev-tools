/**
 * Effect logging routed into the web terminal.
 *
 * Effect's built-in logger (`Effect.logDebug` / `logInfo` / ...) is
 * replaced with one that writes levelled, structured messages to the
 * terminal sink and mirrors them to `console`. The minimum level is a
 * module-level setting controlled by the `log-level` terminal command.
 */
import { Effect, Logger, LogLevel, Duration, Layer } from "effect";

/**
 * @typedef {"trace" | "debug" | "info" | "warn" | "error" | "fatal"} LevelName
 */

/** @type {LevelName[]} */
const LEVEL_ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];

/** @type {LevelName} */
let minimumLevel = "info";

/** @param {LevelName} level */
export function setMinimumLogLevel(level) {
    minimumLevel = level;
}

/** @returns {LevelName} */
export function getMinimumLogLevel() {
    return minimumLevel;
}

/**
 * CSS class per level — matches the terminal's log classes.
 * @param {LogLevel.LogLevel} level
 */
function cssClass(level) {
    const l = level._tag;
    if (l === "Error" || l === "Fatal") return "log-error";
    if (l === "Warning") return "log-warn";
    if (l === "Debug" || l === "Trace" || l === "All") return "log-debug";
    return "log-info";
}

/**
 * Format a log message with span context and annotations into a single line.
 * Spans added with `Effect.withLogSpan` appear as a path
 * (e.g. "cmd.upload > dataverse.upload"); annotations come through as an
 * Effect HashMap (which exposes `.values` pairs, not Map.entries).
 *
 * @param {ReadonlyArray<any>} message
 * @param {any} annotations Effect HashMap | Map of annotation key/values
 * @param {ReadonlyArray<any>} spans current log-span stack
 */
function format(message, annotations, spans) {
    const text = message.join(" ");
    const parts = [];
    if (spans.length) {
        parts.push(spans.map((s) => s.label ?? s.name).join(" > "));
    }
    const pairs = Array.isArray(annotations?.values)
        ? annotations.values
        : annotations instanceof Map
          ? Array.from(annotations.entries())
          : [];
    for (const [k, v] of pairs) {
        parts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
    return parts.length ? `${text} [${parts.join(", ")}]` : text;
}

/**
 * Layer that replaces Effect's default logger with a terminal-sink logger.
 *
 * @param {{ log: (msg: any, opts?: any) => void, info: (msg: any, opts?: any) => void, error: (msg: any, opts?: any) => void }} term
 *        The terminal output sink (anything with log/info/error).
 * @returns {Layer.Layer<never>} logger layer
 */
export function terminalLoggerLayer(term) {
    const custom = Logger.make((/** @type {any} */ { logLevel, message, annotations, spans }) => {
        const min = LEVEL_ORDER.indexOf(minimumLevel);
        const l = LEVEL_ORDER.indexOf(logLevel._tag);
        if (l >= 0 && l < min) return;

        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
        const text = `[${time}] ${logLevel._tag.toLowerCase().padEnd(5)} ${format(message, annotations, Array.from(spans ?? []))}`;
        const cls = cssClass(logLevel);

        // Mirror to console for browser devtools (with stack-friendly object).
        const consoleMethod =
            logLevel._tag === "Error" || logLevel._tag === "Fatal"
                ? console.error
                : logLevel._tag === "Warning"
                  ? console.warn
                  : console.log;
        consoleMethod(`[${logLevel._tag.toLowerCase()}] ${text}`);

        if (cls === "log-error") term.error(text);
        else if (cls === "log-warn") term.log(text, { class: "log-warn" });
        else if (cls === "log-debug") term.log(text, { class: "log-debug" });
        else term.info(text);
    });
    return Logger.replace(Logger.defaultLogger, custom);
}

/**
 * Run an Effect with the terminal logger provided.
 *
 * @template A
 * @template [E=never]
 * @template [R=never]
 * @param {Effect.Effect<A, E, R>} effect
 * @param {Parameters<typeof terminalLoggerLayer>[0]} term
 * @returns {Effect.Effect<A, E, R>}
 */
export function withTerminalLogger(effect, term) {
    return Effect.provide(effect, terminalLoggerLayer(term));
}

/** Convenience re-export so commands don't import `Duration` separately. */
export { Duration };
