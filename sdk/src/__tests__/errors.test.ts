import {
  GovernorError,
  GovernorErrorCode,
  TimelockError,
  TimelockErrorCode,
  VotesError,
  VotesErrorCode,
  parseGovernorError,
  parseTimelockError,
  parseVotesError,
  extractContractErrorCode,
  SorobanRpcError,
} from "../errors";

// ─── extractContractErrorCode ────────────────────────────────────────────────

describe("extractContractErrorCode()", () => {
  it('parses "Error(Contract, #1)" format', () => {
    expect(extractContractErrorCode({ error: "Error(Contract, #1)" })).toBe(1);
  });

  it('parses "Error(Contract, #3)" with a space', () => {
    expect(extractContractErrorCode({ error: "Error(Contract, #3)" })).toBe(3);
  });

  it('parses "ContractError(2)" format', () => {
    expect(
      extractContractErrorCode({ error: "HostError: Value(ContractError(2))" })
    ).toBe(2);
  });

  it('parses "contract error: #5" case-insensitively', () => {
    expect(extractContractErrorCode({ error: "contract error: #5" })).toBe(5);
  });

  it("returns null when error string has no contract code", () => {
    expect(extractContractErrorCode({ error: "RPC timeout" })).toBeNull();
  });

  it("returns null when error is undefined", () => {
    expect(extractContractErrorCode({})).toBeNull();
  });

  it("parses multi-digit codes", () => {
    expect(
      extractContractErrorCode({ error: "Error(Contract, #12)" })
    ).toBe(12);
  });
});

// ─── GovernorError ────────────────────────────────────────────────────────────

describe("GovernorError", () => {
  it("has the correct name", () => {
    const err = new GovernorError(GovernorErrorCode.ProposalExpired, "expired");
    expect(err.name).toBe("GovernorError");
  });

  it("is an instance of Error", () => {
    const err = new GovernorError(GovernorErrorCode.ProposalExpired, "expired");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GovernorError);
  });

  it("stores the code", () => {
    const err = new GovernorError(GovernorErrorCode.UnauthorizedCancel, "msg");
    expect(err.code).toBe(GovernorErrorCode.UnauthorizedCancel);
  });

  it("stores the cause", () => {
    const cause = new Error("root cause");
    const err = new GovernorError(GovernorErrorCode.SimulationFailed, "msg", cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── TimelockError ────────────────────────────────────────────────────────────

describe("TimelockError", () => {
  it("has the correct name", () => {
    const err = new TimelockError(TimelockErrorCode.OperationExpired, "expired");
    expect(err.name).toBe("TimelockError");
  });

  it("is an instance of Error", () => {
    const err = new TimelockError(TimelockErrorCode.OperationExpired, "expired");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TimelockError);
  });

  it("stores the code", () => {
    const err = new TimelockError(TimelockErrorCode.PredecessorNotDone, "msg");
    expect(err.code).toBe(TimelockErrorCode.PredecessorNotDone);
  });
});

// ─── VotesError ───────────────────────────────────────────────────────────────

describe("VotesError", () => {
  it("has the correct name", () => {
    const err = new VotesError(VotesErrorCode.DelegationFailed, "failed");
    expect(err.name).toBe("VotesError");
  });

  it("is an instance of Error", () => {
    const err = new VotesError(VotesErrorCode.DelegationFailed, "failed");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(VotesError);
  });
});

// ─── parseGovernorError ───────────────────────────────────────────────────────

describe("parseGovernorError()", () => {
  it("maps contract error #1 → UnauthorizedCancel with descriptive message", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #1)" };
    const err = parseGovernorError(raw);
    expect(err).toBeInstanceOf(GovernorError);
    expect(err.code).toBe(GovernorErrorCode.UnauthorizedCancel);
    expect(err.message).toContain("proposer or guardian");
  });

  it("maps contract error #2 → InvalidSupport with descriptive message", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #2)" };
    const err = parseGovernorError(raw);
    expect(err.code).toBe(GovernorErrorCode.InvalidSupport);
    expect(err.message).toContain("abstain");
  });

  it("maps contract error #3 → ProposalExpired with descriptive message", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #3)" };
    const err = parseGovernorError(raw);
    expect(err.code).toBe(GovernorErrorCode.ProposalExpired);
    expect(err.message).toContain("expired");
  });

  it("maps unknown contract error codes with a fallback message", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #99)" };
    const err = parseGovernorError(raw);
    expect(err.code).toBe(99 as GovernorErrorCode);
    expect(err.message).toContain("Governor contract error #99");
  });

  it('maps status="ERROR" without contract code → TransactionFailed', () => {
    const raw: SorobanRpcError = { status: "ERROR", error: "network timeout" };
    const err = parseGovernorError(raw);
    expect(err.code).toBe(GovernorErrorCode.TransactionFailed);
    expect(err.message).toContain("Transaction failed");
    expect(err.message).toContain("network timeout");
  });

  it("maps simulation failure → SimulationFailed", () => {
    const raw: SorobanRpcError = { error: "simulation error" };
    const err = parseGovernorError(raw);
    expect(err.code).toBe(GovernorErrorCode.SimulationFailed);
    expect(err.message).toContain("Simulation failed");
  });

  it("forwards the cause argument", () => {
    const cause = new Error("root");
    const raw: SorobanRpcError = { status: "ERROR", error: "rejected" };
    const err = parseGovernorError(raw, cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── parseTimelockError ───────────────────────────────────────────────────────

describe("parseTimelockError()", () => {
  it("maps contract error #1 → PredecessorNotDone", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #1)" };
    const err = parseTimelockError(raw);
    expect(err).toBeInstanceOf(TimelockError);
    expect(err.code).toBe(TimelockErrorCode.PredecessorNotDone);
    expect(err.message).toContain("predecessor");
  });

  it("maps contract error #2 → PredecessorNotFound", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #2)" };
    const err = parseTimelockError(raw);
    expect(err.code).toBe(TimelockErrorCode.PredecessorNotFound);
  });

  it("maps contract error #3 → OperationExpired", () => {
    const raw: SorobanRpcError = { error: "Error(Contract, #3)" };
    const err = parseTimelockError(raw);
    expect(err.code).toBe(TimelockErrorCode.OperationExpired);
    expect(err.message).toContain("expired");
  });

  it('maps status="ERROR" → TransactionFailed', () => {
    const raw: SorobanRpcError = { status: "ERROR", error: "rejected" };
    const err = parseTimelockError(raw);
    expect(err.code).toBe(TimelockErrorCode.TransactionFailed);
    expect(err.message).toContain("Transaction failed");
  });

  it("maps simulation failure → SimulationFailed", () => {
    const raw: SorobanRpcError = { error: "ledger not found" };
    const err = parseTimelockError(raw);
    expect(err.code).toBe(TimelockErrorCode.SimulationFailed);
  });
});

// ─── parseVotesError ──────────────────────────────────────────────────────────

describe("parseVotesError()", () => {
  it('maps status="ERROR" → TransactionFailed', () => {
    const raw: SorobanRpcError = { status: "ERROR", error: "insufficient fee" };
    const err = parseVotesError(raw);
    expect(err).toBeInstanceOf(VotesError);
    expect(err.code).toBe(VotesErrorCode.TransactionFailed);
    expect(err.message).toContain("Transaction failed");
    expect(err.message).toContain("insufficient fee");
  });

  it("maps non-ERROR → SimulationFailed", () => {
    const raw: SorobanRpcError = { error: "simulate failed" };
    const err = parseVotesError(raw);
    expect(err.code).toBe(VotesErrorCode.SimulationFailed);
    expect(err.message).toContain("Simulation failed");
  });

  it("forwards the cause argument", () => {
    const cause = { code: 42 };
    const raw: SorobanRpcError = { status: "ERROR" };
    const err = parseVotesError(raw, cause);
    expect(err.cause).toBe(cause);
  });
});
