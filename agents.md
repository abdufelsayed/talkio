Development guide for the voice-ai monorepo.

## Monorepo Structure

```
voice-ai/
├── packages/
│   ├── talkio/            # Core orchestration library (talkio)
│   └── deepgram/        # @talkio/deepgram provider
├── tooling/
│   └── tsconfig/        # Shared TypeScript configs
├── turbo.json           # Turborepo configuration
└── package.json         # Root workspace
```

Each package has its own `agents.md` with package-specific guidance.

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
bun run --cwd packages/core test
bun run --cwd packages/core test test/unit/actors/stt.test.ts

# Or use absolute paths
bun run test --cwd packages/core

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

## Naming

- Types: `PascalCase`
- Variables/functions: `camelCase`
- Files: `kebab-case.ts`
- Test files: `*.test.ts`

## Testing

- Framework: Vitest
- Unit tests: `test/unit/`
- Integration tests: `test/integration/`
- Use `vi.waitFor()` for async assertions

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

Note: The core package has been renamed from `voice-ai` to `talkio` and the directory from `packages/voice-ai` to `packages/core`.

## Comments

**STRICT RULES - NEVER VIOLATE:**

- **NO decorative comments** — no banners, separators, or visual decorations
- **NO inline comments about changes** — never add comments like "// Changed this", "// Updated", "// Fixed", etc.
- **NO obvious comments** — don't comment what the code already clearly shows
- Comments should ONLY explain **why**, not **what** or **how**
- Only add comments when they provide non-obvious context or explain complex logic
- Prefer self-documenting code over comments
