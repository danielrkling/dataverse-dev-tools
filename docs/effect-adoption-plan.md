# Effect Adoption Plan

> Incremental plan to adopt Effect in the browser IDE: first for the
> watch/rebuild/upload pipelines (concurrency, debouncing, cancellation),
> then logging, then the command runtime and AI tools.

## 0. Decisions & Constraints

| Decision | Choice | Rationale |
|---|---|---|
| Version | Effect **v4** (`effect@rc` until stable) | Starting fresh now; avoids v3→v4 migration later. Schema ships in core. |
| Where Effect lives | `src/effects/` folder, **JSDoc `.mjs` first**, `.ts` only where annotations get unwieldy | `tsconfig.json` already enforces `strict` + `checkJs`, so Effect's type inference (errors/requirements) works in JSDoc. `.ts` allowed per-file (e.g. service Tags/Layers) if `@typedef` boilerplate becomes excessive. |
| Scope | Pipeline-first, not command-first | Commands (`ls`, `cat`, `pwd`…) gain nothing. esbuild/git/Dataverse pipelines gain the most. |
| AI layer | **`@tanstack/ai` stays** as the UI/chat layer; tools run Effect internally, exposed to TanStack as plain async `execute` functions. Re-evaluate `@effect/ai-openai` later (see §6). | TanStack AI expects Zod schemas + plain promises. Keep Effect at the service layer, not the tool-call boundary. |
| Optique parsers | Keep | Parsing stays as-is. Effect wraps the `execute` phase only. |

## 1. Packages to install

```
effect                        # core (Schema, Stream, Logger, Layers)
@effect/platform              # Fetch HttpClient, FileSystem interfaces
@effect/platform-browser      # browser implementations (HttpClient via fetch)
```

Later, optional:

- `@effect/opentelemetry` — only if we want trace export; browser spans
  can also just be logged.
- `@effect/ai-openai` / `@effect/ai-anthropic` — alternative AI runtime (see §6).
- `@effect/vitest` — needs Vitest; our tests are Playwright. Skip for now,
  test via `Effect.runPromise` in Playwright tests.

## 2. Phase 1 — Watch pipeline (the pain that started this)

Goal: replace the three stacked debouncers (`fs.watch` per-path map,
`workspace.mjs` 100 ms, command-level 300 ms) with one Effect Stream
pipeline. Fixes: overlapping esbuild rebuilds, stale content uploads,
self-triggered events.

### 2.1 New file: `src/effects/watch-pipeline.ts`

```
bus "fs:changed" events
  → Stream.fromAsyncIterable / fromEventListener (bus adapter)
  → Stream.filter (echo suppression + path match)
  → Stream.debounce(200ms)                      // one place, one delay
  → Stream.mapEffect(rebuildOrUpload)           // via Effect.makeSemaphore(1)
  → Stream.runDrain
```

- **Semaphore(1)** guarantees a rebuild/upload never overlaps another.
- **Debounce happens once**, at the consumer — `fs.watch` emits raw.
- **Cancellation**: starting a run in "interrupt mode" cancels the previous
  fiber (`Effect.fork` + `Fiber.interrupt`), or "skip mode" with the
  semaphore. Per-command choice.

### 2.2 Echo suppression: `src/effects/echo-guard.ts`

- `terminal.fs.writeFile` records written paths in a `Set` with a timestamp.
- The pipeline filters out events for these paths within ~1 s.
- Kills the write-outputs-back-into-VFS feedback loop class of bugs.

### 2.3 Migrate in this order

1. `esbuild.mjs` watch mode → rebuild pipeline (biggest win).
2. `dataverse.mjs` `-w` upload pipeline (gets retries + semaphore).
3. `workspace.mjs` autosave→Dataverse debounce → part of the same stream.
4. Leave `fs.watch`'s internal debounce as a safety net at first; remove
   once confident (single debounce point).

### 2.4 Errors

Define tagged errors, replace string failures:

```ts
class RebuildError extends Data.TaggedError("RebuildError")<{ cause: unknown }> {}
class DataverseUploadError extends Data.TaggedError("DataverseUploadError")<{
  path: string; status?: number; cause: unknown;
}> {}
```

Upload gets `Effect.retry(Schedule.exponential("200 millis").pipe(
Schedule.compose(Schedule.recurs(3))))` — Dataverse API flakiness handled
in one line instead of ad-hoc code.

## 3. Phase 2 — Logging (multilevel, structured, into the terminal)

This is a major payoff for an IDE. Design:

### 3.1 Custom terminal Logger

- Implement `Effect.Logger` that routes to the web terminal sink
  (`term.log/info/error`) and `console` for non-visible contexts.
- Levelled: `trace | debug | info | warn | error | fatal` with terminal CSS
  classes per level (`log-debug`, `log-warn`, …).
- Runtime level control: a `log-level` terminal command maps to
  `Logger.withMinimumLogLevel` (e.g. `log-level debug` shows everything).
  Default in dev: `debug` for our code, `info` for libraries.

### 3.2 Structured logs, not strings

- Log with annotations: `Effect.logDebug("rebuild complete").pipe(
  Effect.annotateLogs({ files: outputs.length, ms: duration }))`.
- Annotations flow automatically from spans — every command run is a span
  (`Effect.withSpan("cmd.esbuild.watch")`), so logs from nested effects are
  correlated to the command + a run id. This directly answers "what
  triggered this rebuild?" debugging.

### 3.3 Log history service

- A `Ref` holding a ring buffer of structured log entries →
  new `log-history` / `log-show <level>` terminal commands, and a future
  "Logs" panel in the IDE UI.

## 4. Phase 3 — Services as Layers (replaces the `any` term context)

Model the execution context as Effect services instead of the ad-hoc
`term` object:

```
Tag<WorkspaceFs>     // read/write/stat/watch (wraps services/fs.mjs)
Tag<DataverseApi>    // publish/whoAmI/upload webresources
Tag<GitApi>          // wraps isomorphic-git
Tag<TerminalSink>    // log/info/error output
Tag<EsbuildService>  // context/rebuild/dispose
```

- Layer composition in one `src/effects/runtime.ts`.
- Commands migrate one-by-one: `execute` becomes an Effect that
  `yield*`s the services it needs; `CommandRegistry._execCommand` runs
  `Effect.runPromise` with the runtime.
- Type-level guarantee: a command that needs `DataverseApi` can't run
  where it isn't provided.
- Testing: swap in test Layers; Playwright tests get deterministic FS/DV mocks.

## 5. Phase 4 — Command registry integration

- `createCommand` gains an optional `executeEffect` alongside `execute`
  (bridge internally, no breaking change).
- `&&`/`&` groups: parallel groups run via `Effect.all(..., "unbounded")`,
  serial groups sequenced — with per-command spans and shared
  cancellation when the terminal is disposed.
- `help`, aliases, Optique parsing untouched.

## 6. Phase 5 — AI tools (`@tanstack/ai`)

- **One schema per command.** Each command defines its params once.
  TanStack AI tools need Zod; Effect v4 uses Effect Schema. For Effect-only
  internals use Effect Schema; at the TanStack boundary keep Zod and feed
  it to both `createTool` and the (existing Optique) parser — or write a
  small Zod↔Effect-Schema bridge for commands that run through Effect.
- Tool `execute` calls the command's Effect via `Effect.runPromise`,
  converting tagged errors into tool-call error results the model can read
  (`DataverseUploadError: 403 …`) — the LLM gets typed, actionable errors
  instead of stack traces.
- Every tool call wrapped in `Effect.withSpan("ai.tool.<name>")` +
  timeout (`Effect.timeout("30 seconds")`) so a hung Dataverse call can't
  hang the agent loop.
- **Revisit `@effect/ai` later**: if we ever want the agent loop itself
  (multi-turn, provider fallbacks, streaming) to be Effect-native,
  `@effect/ai-openai` / `@effect/ai-anthropic` give retries/fallbacks/
  spans for free. For now TanStack AI owns the loop; Effect owns the tools.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Bundle size (~60–120 kB gz core) | Vite tree-shakes; code-split `src/effects/` is fine since it's a dev tool. Measure after Phase 1. |
| v4 RC churn | Pin exact versions; effect.website has a v3→v4 migration guide. |
| JSDoc friction | Effect inference works under existing `strict`+`checkJs`; use `.ts` selectively for Tag/Layer-heavy files if `@typedef` boilerplate hurts. |
| Learning curve | Pipeline-first (streams/semaphore) is the easiest Effect entry; Layer/DI comes later. |
| Streaming terminal output | Keep `term.log` for human streaming; Effect `Logger` handles structured events. |

## 8. Suggested milestones

1. **M1 (Phase 1+2)**: watch pipeline + echo guard + terminal logger + `log-level` command. The double-trigger bug is fixed here.
2. **M2 (Phase 3)**: core services as Layers; migrate `dataverse`, `esbuild`, `git` commands.
3. **M3 (Phase 4)**: registry bridge (`executeEffect`), spans per command.
4. **M4 (Phase 5)**: TanStack AI tools on top, typed errors → model feedback.
