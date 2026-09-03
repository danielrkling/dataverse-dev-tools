/**
 * Effect-based watch pipeline.
 *
 * Replaces the ad-hoc stacked debouncers with one pipeline:
 *
 *   bus events → filter (match + echo guard) → Stream.debounce
 *              → serialized handler (Effect.makeSemaphore(1)) → drain
 *
 * Guarantees:
 * - one debounce point per pipeline (no double-triggering across layers)
 * - a handler never overlaps itself (semaphore = 1)
 * - the "stop" button interrupts the fiber and cleans everything up
 */
import { Effect, Queue, Stream, Duration, Fiber, Layer } from "effect";
import { isEcho } from "./echo-guard.mjs";
import { withTerminalLogger } from "./logger.mjs";

/**
 * @typedef {{ path: string, type: string }} FsEvent
 * @typedef {{
 *     name: string,
 *     debounceMs?: number,
 *     timeoutMs?: number,
 *     match?: (path: string) => boolean,
 *     suppressEchoes?: boolean,
 *     handler: (event: FsEvent) => Effect.Effect<any, any, any>,
 *     onEvent?: (event: FsEvent) => void,   // called before debounce, for UI feedback
 *     layer?: Layer.Layer<any, any, any>,   // context (services) provided to the handler
 *     term: any,                            // terminal sink for logging
 * }} WatchPipelineOptions
 */

/**
 * Create a debounced, serialized watch pipeline.
 *
 * @param {WatchPipelineOptions} options
 * @returns {{ push: (event: FsEvent) => void, stop: () => Promise<void> }}
 */
export function createWatchPipeline(options) {
    const debounceMs = options.debounceMs ?? 200;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const match = options.match ?? (() => true);
    const suppressEchoes = options.suppressEchoes ?? true;

    const queue = Effect.runSync(Queue.unbounded());
    const semaphore = Effect.runSync(Effect.makeSemaphore(1));

    let program = Stream.fromQueue(queue).pipe(
        Stream.filter((e) => {
            if (!e?.path || !match(e.path)) return false;
            if (suppressEchoes && isEcho(e.path)) {
                Effect.runSync(Effect.logDebug(`echo suppressed: ${e.path}`));
                return false;
            }
            return true;
        }),
        Stream.tap((e) => {
            options.onEvent?.(e);
            return Effect.void;
        }),
        // The single debounce point — coalesces bursts of events.
        Stream.debounce(Duration.millis(debounceMs)),
        Stream.mapEffect((e) =>
            semaphore.withPermits(1)(
                options.handler(e).pipe(
                    Effect.withLogSpan(options.name),
                    Effect.timeout(Duration.millis(timeoutMs)),
                    Effect.tap(() =>
                        Effect.logDebug(`${options.name}: handled ${e.type} ${e.path}`),
                    ),
                    Effect.catchAll((err) =>
                        Effect.logError(
                            `${options.name}: failed for ${e.path}: ${
                                /** @type {any} */ (err)?.message ??
                                /** @type {any} */ (err)?._tag ??
                                String(err)
                            }`,
                        ),
                    ),
                ),
            ),
        ),
        Stream.runDrain,
    );

    if (options.layer) {
        program = /** @type {typeof program} */ (
            Effect.provide(program, options.layer)
        );
    }

    const fiber = Effect.runFork(
        withTerminalLogger(
            /** @type {Effect.Effect<void, never, never>} */ (program),
            options.term,
        ),
    );

    return {
        /** @param {FsEvent} event */
        push(event) {
            Effect.runSync(Queue.offer(queue, event));
        },
        /** Interrupt the pipeline; resolves when the fiber is done. */
        stop() {
            return Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid));
        },
    };
}
