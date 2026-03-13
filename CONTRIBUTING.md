# Contributing to NebGov

NebGov is an open-source governance framework for the Stellar ecosystem. All contributions are welcome — bug fixes, features, documentation, and tests.

## How to Contribute

### 1. Find an issue
Browse [open issues](https://github.com/nebgov/nebgov/issues). Each issue is tagged with:
- `complexity: trivial` — small, well-scoped change
- `complexity: medium` — moderate implementation work
- `complexity: high` — significant feature or architectural change

Issues tagged `good first issue` are recommended for first-time contributors.

### 2. Fork and branch
```bash
git checkout -b feat/issue-<number>-<short-description>
```

### 3. Implement and test
- Rust contracts: `cargo test --workspace`
- SDK: `pnpm test:sdk`
- Frontend: `pnpm test:app`

### 4. Open a PR
- Reference the issue: `Closes #<number>`
- Describe what you changed and why
- All CI checks must pass

## Code Standards

### Rust (contracts)
- Follow standard Rust formatting: `cargo fmt`
- No unsafe code
- All public functions must have a doc comment
- Tests live in `#[cfg(test)]` modules within each contract

### TypeScript (SDK + frontend)
- Strict TypeScript — no `any` types
- Run `pnpm lint` before pushing

### Commit messages
Use imperative mood: `Add vote checkpointing to token-votes`, not `Added...`

## Issue Scope

Each issue is scoped to be completable in **under one week** by a single contributor. If you find that an issue is larger than expected, comment on it so it can be split.

## Questions?

Open a discussion on GitHub.
