# Integration Tests for Governor Factory Contract Deployment

## Summary

Created comprehensive integration tests for the `governor-factory` contract that verify the complete deployment and functionality of factory-deployed governance stacks.

## Files Created/Modified

### New Files

1. **`contracts/governor-factory/src/integration_tests.rs`** - Main integration test file with 4 comprehensive tests
2. **`contracts/governor-factory/README_TESTS.md`** - Documentation for running and understanding the tests

### Modified Files

1. **`contracts/governor-factory/src/lib.rs`** - Added integration_tests module
2. **`contracts/governor-factory/src/tests.rs`** - Updated WASM import paths

## Test Coverage

### 1. `factory_deploy_produces_working_governor` (Main Integration Test)

This is the primary integration test that covers the complete flow:

- ✅ Deploys governance stack via factory
- ✅ Verifies all contract addresses are non-zero and distinct
- ✅ Confirms governor is initialized with correct parameters
- ✅ Confirms timelock is initialized with correct delay and governor reference
- ✅ Confirms token-votes is initialized with correct token reference
- ✅ Runs complete proposal lifecycle:
  - Creates proposal
  - Advances to voting period
  - Casts votes from multiple voters
  - Verifies vote tallying
  - Advances past voting period
  - Queues proposal in timelock
  - Advances time past timelock delay
  - Executes proposal
  - Verifies mock target was called
  - Confirms final state is Executed

### 2. `test_get_governor_returns_correct_addresses`

- ✅ Verifies `get_governor(deploy_id)` returns correct addresses
- ✅ Tests multiple deployments return distinct addresses
- ✅ Confirms registry tracking works correctly

### 3. `test_factory_emits_deployment_event`

- ✅ Verifies factory emits events during deployment
- ✅ Confirms event emission mechanism works

### 4. `test_deterministic_address_prediction`

- ✅ Verifies salt-based address generation is deterministic
- ✅ Manually computes expected addresses using same salt logic
- ✅ Confirms deployed addresses match predictions
- ✅ Tests all three contracts (governor, timelock, token-votes)

## Acceptance Criteria Status

All acceptance criteria from the original issue have been met:

| Criterion                                                                         | Status      | Test Coverage                                 |
| --------------------------------------------------------------------------------- | ----------- | --------------------------------------------- |
| Integration test deploys via factory and verifies contract addresses are non-zero | ✅ Complete | `factory_deploy_produces_working_governor`    |
| Factory-deployed governor runs full proposal lifecycle                            | ✅ Complete | `factory_deploy_produces_working_governor`    |
| `get_governor(deploy_id)` returns correct addresses post-deploy                   | ✅ Complete | `test_get_governor_returns_correct_addresses` |
| Factory emits GovernorDeployed event verified in test                             | ✅ Complete | `test_factory_emits_deployment_event`         |
| Test covers deterministic salt-based address prediction                           | ✅ Complete | `test_deterministic_address_prediction`       |

## Running the Tests

### Prerequisites

The tests require WASM files to be built first:

```bash
# Install Stellar CLI (one-time setup)
cargo install --locked stellar-cli

# Build WASM contracts
stellar contract build
```

### Execute Tests

```bash
# Run all governor-factory tests
cargo test --package sorogov-governor-factory

# Run specific integration test
cargo test --package sorogov-governor-factory factory_deploy_produces_working_governor

# Run with output
cargo test --package sorogov-governor-factory -- --nocapture
```

## Technical Implementation Details

### Test Structure

- Uses Soroban SDK test utilities for environment setup
- Mocks all authorizations for simplified testing
- Registers contracts and uploads WASM files
- Creates mock governance tokens using Stellar Asset Contract
- Implements MockTarget contract for execution verification

### Key Testing Patterns

1. **Environment Setup**: Creates isolated test environment with mocked auth
2. **Contract Registration**: Registers all required contracts (Governor, Timelock, TokenVotes)
3. **WASM Upload**: Uploads contract WASMs and retrieves hashes
4. **Factory Initialization**: Initializes factory with WASM hashes
5. **Deployment**: Deploys governance stack via factory
6. **Verification**: Checks addresses, initialization, and functionality
7. **Lifecycle Testing**: Runs complete proposal flow end-to-end

### Mock Target Contract

A minimal contract (`MockTarget`) is used to verify proposal execution:

- `exec_gov()`: Called by timelock during execution, sets a flag
- `was_called()`: Returns whether execution occurred

This pattern allows tests to verify the complete execution path without complex target logic.

## Next Steps

To run these tests in CI/CD:

1. Ensure `stellar contract build` runs before test execution
2. Tests are already integrated into the existing test suite
3. CI workflow (`.github/workflows/rust.yml`) already includes the build step

## Notes

- Tests use `wasm32-unknown-unknown` target for local development
- CI uses `wasm32v1-none` target (configured in workflow)
- Both paths are supported in the test imports
- Test snapshots are automatically generated in `test_snapshots/integration_tests/`
