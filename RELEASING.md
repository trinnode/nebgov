# Release Process

This document outlines the tag-and-release process for maintainers of the NebGov repository.

## Prerequisites

Ensure the following secrets are configured in the GitHub repository before initiating a release:
- `NPM_TOKEN`: Required for publishing the `@nebgov/sdk` to npm.
- `GITHUB_TOKEN`: Required for creating the GitHub release and uploading artifacts.

## How to Release

1. **Verify CI**: Ensure that the `main` branch is passing all CI checks (`cargo test`, `pnpm test`, etc.).
2. **Update Versions**: If necessary, update the version in `sdk/package.json` and any other relevant files. Merge this change into `main`.
3. **Create a Tag**: Create an annotated git tag following the semantic versioning format `v*.*.*`.
   ```bash
   git tag -a v1.0.0 -m "Release v1.0.0"
   git push origin v1.0.0
   ```
4. **GitHub Actions**: The push of the tag will automatically trigger the `.github/workflows/release.yml` workflow.
   - The workflow runs the full test suite.
   - Builds and optimizes the Soroban smart contracts (`.wasm` files).
   - Publishes the SDK to npm.
   - Drafts a new GitHub release with auto-generated release notes and attaches the optimized WASM artifacts.

## Aborting a Release

If any test fails during the automated release workflow, the process will abort, preventing the release of broken artifacts. You must address the issues, commit the fixes, and push a new tag to retry the release process.
