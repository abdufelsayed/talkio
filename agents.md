Development guide for the Talkio monorepo.

## Monorepo Structure

```
talkio/
├── packages/
│   ├── talkio/          # Core orchestration library (talkio)
│   ├── deepgram/        # @talkio/deepgram provider
│   └── testkit/         # @talkio/testkit: scenarios, fakes, conformance
├── examples/
│   └── simple/          # WebSocket server and browser client
├── docs/                # Guides (testkit)
├── tooling/
│   └── tsconfig/        # Shared TypeScript configs
├── turbo.json           # Turborepo configuration
└── package.json         # Root workspace
```

## Architecture

- The core (`packages/talkio`) is provider-independent. It defines the provider contracts in `src/providers/types.ts`; vendor-specific behavior belongs in provider packages.
- Core logic lives in pure modules next to `src/agent/machine.ts` (speech, playback, overlap, turn-taking, history, metrics) and is tested directly. Machine actions only sequence it. The comment at the top of `machine.ts` describes the parallel regions.
- XState runs eventless (`always`) transitions before raised events, so a guard that starts new work must account for events still queued (see `userTurnCommitting`).

`packages/testkit/agents.md` has the testkit's own constraints.

## Commands

**IMPORTANT: Command Execution Rules**

- **NEVER use `cd` commands** - they conflict with zoxide and cause errors
- **NEVER run `bun vitest` directly** - use `bun run test` or package scripts instead
- Use `--cwd` flag or absolute paths when running commands in specific packages
- Always use package.json scripts when available

Run from root directory:

```bash
bun run dev           # Watch mode
bun run build         # Build all packages
bun run test          # Run tests
bun run test:watch    # Watch mode tests
bun run typecheck     # Type checking
bun run lint          # oxlint
bun run format        # oxfmt
bun run clean         # Remove dist, node_modules, .turbo
```

Run in specific package:

```bash
# Use --cwd flag (preferred)
bun run --cwd packages/talkio test
bun run --cwd packages/talkio test test/agent/interruption.test.ts

# Or use absolute paths
bun run test --cwd packages/talkio

# Or use package.json scripts with filters
bun run test --filter talkio
```

## Code Style

- **Linter**: oxlint (`.oxlintrc.json`)
- **Formatter**: oxfmt (`.oxfmtrc.json`)
- 2-space indentation
- Double quotes
- Semicolons required
- Trailing commas

## TypeScript

- Strict mode enabled
- `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`
- Use `type` for aliases, `interface` for extensible shapes
- Prefer discriminated unions over string unions
- Avoid `any` — use `unknown` with type guards

## Conventions

- Events are discriminated unions. Internal events start with `_` and never reach `onEvent`.
- Providers report errors through `ctx.error()` instead of throwing, and emit nothing once `ctx.signal` aborts.
- AbortErrors are expected during cancellation and ignored.
- Never mutate messages or machine context; build new values.

## Naming

- Types: `PascalCase`
- Variables/functions: `camelCase`
- Files: `kebab-case.ts`
- Test files: `*.test.ts`

## Testing

- Framework: Vitest
- Tests live in each package's `test/` directory (core: `test/agent/`, `test/machine/`, `test/types/`)
- Use `vi.waitFor()` for async assertions
- `SimulatedClock.increment(ms)` moves the clock before firing timers, so a timer scheduled during the jump counts from its end. Advance in steps to land on each scheduled time.
- Vitest's `toEqual` treats any two `ArrayBuffer`s as equal; compare bytes (`bytesOf` in the core test helpers).
- A fake TTS's `requests` only holds requests still being synthesized; assert on `requestedTexts` for everything the agent asked to say.
- Make sure a new test fails when the behavior it covers is broken: change the code and rerun it.

## Bug Fixes and Package Development

**CRITICAL: Package vs Example App Priority**

- **ALWAYS fix bugs in packages first** (`packages/talkio/`, `packages/deepgram/`, etc.)
- **NEVER fix bugs by modifying example apps** (`examples/` directory)
- Example apps are for demonstration only - they use the packages, they don't define them
- When a bug is reported, identify the root cause in the package code, not the example usage
- If an example app has an issue, it's likely because the package has a bug or missing feature
- Only modify example apps if explicitly asked to update the example itself, not to work around package bugs

**Example of WRONG approach:**

- Bug: "SpeechStarted event fires on background noise"
- ❌ WRONG: Disable VAD in `examples/simple/src/server.ts`
- ✅ CORRECT: Fix VAD handling in `packages/deepgram/src/deepgram-stt.ts`

## Comments

**STRICT RULES - NEVER VIOLATE:**

- **NO decorative comments** — no banners, separators, or visual decorations
- **NO inline comments about changes** — never add comments like "// Changed this", "// Updated", "// Fixed", etc.
- **NO obvious comments** — don't comment what the code already clearly shows
- Comments should ONLY explain **why**, not **what** or **how**
- Only add comments when they provide non-obvious context or explain complex logic
- Prefer self-documenting code over comments
