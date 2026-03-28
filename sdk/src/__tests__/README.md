# SDK Unit Tests

This directory contains comprehensive unit tests for the NebGov SDK clients.

## Test Structure

The test suite follows a consistent pattern across all three client modules:

### Test Files

- `governor.test.ts` - Tests for GovernorClient
- `timelock.test.ts` - Tests for TimelockClient
- `votes.test.ts` - Tests for VotesClient
- `integration.test.ts` - Integration tests against live testnet (skipped in CI without env vars)

### Test Organization

Each test file is organized by method with the following structure:

```typescript
describe('ClientName', () => {
  describe('methodName()', () => {
    it('returns expected result on success', async () => { ... });
    it('throws error when validation fails', async () => { ... });
    it('handles edge cases correctly', async () => { ... });
  });
});
```

## Mocking Strategy

All tests use mocked Stellar SDK components to avoid real network calls:

- `SorobanRpc.Server` - Mocked RPC server
- `simulateTransaction` - Mocked for read operations
- `sendTransaction` / `getTransaction` - Mocked for write operations
- `scValToNative` / `nativeToScVal` - Mocked for data conversion

This ensures:

- Fast test execution
- No external dependencies
- Deterministic results
- No testnet costs

## Running Tests

```bash
# Run all tests
pnpm --filter sdk test

# Run with coverage report
pnpm --filter sdk test:coverage

# Run specific test file
pnpm --filter sdk test governor.test.ts

# Run in watch mode (for development)
pnpm --filter sdk test --watch
```

## Coverage Requirements

The test suite enforces minimum 80% coverage across:

- Statements
- Branches
- Functions
- Lines

Current coverage: **99%+** across all metrics

Files excluded from coverage:

- `events.ts` - Event subscription utilities (requires complex async mocking)
- `types/` - Type definitions only
- `index.ts` - Re-exports only

## Test Coverage by Client

### GovernorClient (100% coverage)

- ✅ `getProposalState()` - All 7 state variants + error cases
- ✅ `propose()` - Success, transaction errors, confirmation failures, timeouts
- ✅ `castVote()` - All vote types (For/Against/Abstain) + errors
- ✅ `getProposalVotes()` - Vote breakdown + error handling
- ✅ `proposalCount()` - Count retrieval + error handling

### TimelockClient (98% coverage)

- ✅ `schedule()` - Success, errors, missing return value, delay validation
- ✅ `execute()` - Success, not ready, not found, unauthorized
- ✅ `cancel()` - Success, already executed, not found, unauthorized
- ✅ `isReady()` - True/false states + error handling
- ✅ `isPending()` - True/false states + error handling
- ✅ `minDelay()` - Delay retrieval + error handling

### VotesClient (100% coverage)

- ✅ `delegate()` - Success, self-delegation, errors, parameter validation
- ✅ `getVotes()` - Current power, zero power, large values, errors
- ✅ `getPastVotes()` - Historical power, ledger parameter, errors
- ✅ `getDelegatee()` - Current delegatee, null state, self-delegation, errors

## Key Testing Patterns

### Async Timer Handling

Tests that involve polling (propose, castVote, execute, etc.) use Jest fake timers:

```typescript
beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it("polls for confirmation", async () => {
  const promise = client.someMethod();
  await jest.advanceTimersByTimeAsync(2000);
  await promise;
});
```

### Error Case Testing

Every method tests both happy path and error scenarios:

```typescript
it('throws error when transaction fails', async () => {
  mockSendTransaction.mockResolvedValue({
    status: 'ERROR',
    error: 'Insufficient voting power',
  });

  await expect(
    client.propose(...)
  ).rejects.toThrow('Transaction failed');
});
```

### Simulation Mocking

Read-only methods use simulation mocking:

```typescript
it("returns current voting power", async () => {
  const scv = {} as xdr.ScVal;
  mockSimulate.mockResolvedValue({
    result: { retval: scv },
  });
  mockScValToNative.mockReturnValue(1000);

  const votes = await client.getVotes(accountAddr);
  expect(votes).toBe(1000n);
});
```

## Adding New Tests

When adding new SDK methods:

1. Add test cases to the appropriate test file
2. Mock all external dependencies
3. Test both success and error paths
4. Verify coverage remains above 80%
5. Run `pnpm --filter sdk test:coverage` to confirm

## CI Integration

Tests run automatically on:

- Pull requests
- Pushes to main branch
- Pre-commit hooks (if configured)

Coverage reports are generated and can be uploaded to services like Codecov.
