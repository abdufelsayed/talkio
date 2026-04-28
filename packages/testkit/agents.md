# @talkio/testkit Package

Testing utilities, simulators, and conformance helpers for Talkio.

## Scope

- Keep the public API runner-agnostic. Do not depend on Vitest in `src/`.
- Prefer public Talkio exports over imports from package internals.
- Keep scenario traces serializable unless an API is explicitly documented as runtime-only.
- Default audio in scenarios should be compact synthetic buffers, not checked-in binary blobs.
- Use `fast-check` for property-based trace generation.
- Use `@xstate/graph` for machine path coverage, not as the main public behavior contract.
- Provider conformance should be offline by default. Live provider tests must be opt-in.

## Commands

Use package scripts from the repo root:

```bash
bun run --cwd packages/testkit test
bun run --cwd packages/testkit typecheck
bun run --cwd packages/testkit build
```

Do not run `bun vitest` directly.
