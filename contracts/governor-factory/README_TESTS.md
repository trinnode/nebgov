# Governor Factory Integration Tests

## Overview

This directory contains comprehensive integration tests for the governor-factory contract that verify:

1. Factory deployment produces working governor contracts
2. Full proposal lifecycle through factory-deployed governors
3. `get_governor()` returns correct addresses post-deploy
4. Factory emits deployment events
5. Deterministic salt-based address prediction

## Running Tests

### Prerequisites

Before running the integration tests, you must build the WASM contracts:

```bash
# Install Stellar CLI (if not already installed)
cargo install --locked stellar-cli

# Build all contracts to generate WASM files
stellar contract build
```

This will generate the required WASM files in `target/wasm32v1-none/release/`.

### Run All Tests

```bash
cargo test --package sorogov-governor-factory
```

### Run Specific Test

```bash
cargo test --package sorogov-governor-factory factory_deploy_produces_working_governor
```

## Test Structure

### Unit Tests (`tests.rs`)

- `test_initialize_twice_panics` - Verifies factory can't be initialized twice
- `test_deploy_full_stack` - Basic deployment verification
- `test_second_deploy_has_different_addresses` - Verifies unique addresses per deployment

### Integration Tests (`integration_tests.rs`)

- `factory_deploy_produces_working_governor` - **Main integration test** that:
  - Deploys via factory
  - Verifies all contract addresses are non-zero and distinct
  - Runs a complete proposal lifecycle (propose → vote → queue → execute)
  - Confirms the mock target was called after execution

- `test_get_governor_returns_correct_addresses` - Verifies registry lookup

- `test_factory_emits_deployment_event` - Verifies event emission

- `test_deterministic_address_prediction` - Verifies salt-based address generation

## Troubleshooting

### Error: "reference-types not enabled"

This means the WASM files haven't been built yet or were built with the wrong target. Run:

```bash
stellar contract build
```

### Error: "No such file or directory" for WASM files

The WASM files are generated during the build process. Make sure you've run `stellar contract build` before running tests.

## Test Coverage

The integration tests cover all acceptance criteria from the original issue:

- ✅ Integration test deploys via factory and verifies contract addresses are non-zero
- ✅ Factory-deployed governor runs full proposal lifecycle
- ✅ `get_governor(deploy_id)` returns correct addresses post-deploy
- ✅ Factory emits deployment events verified in test
- ✅ Test covers deterministic salt-based address prediction
