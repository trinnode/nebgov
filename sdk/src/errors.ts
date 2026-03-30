/**
 * NebGov SDK — typed error system
 *
 * All SDK methods throw one of GovernorError, TimelockError, or VotesError
 * instead of raw Error objects. Each error carries a typed code so callers
 * can branch on specific failure modes without string-matching messages.
 *
 * Contract error codes are taken directly from the on-chain #[contracterror]
 * enums; SDK-level codes (≥ 100) cover RPC/transport failures.
 */

// ─── Governor Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Governor contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain GovernorError enum values so that the numeric
 * code you receive matches what is written in the Rust contract.
 */
export enum GovernorErrorCode {
  // On-chain contract errors (match contracts/governor/src/lib.rs)
  UnauthorizedCancel = 1,
  InvalidSupport     = 2,
  ProposalExpired    = 3,

  // SDK-level codes
  ProposalNotFound    = 100,
  SimulationFailed    = 101,
  TransactionFailed   = 102,
  TransactionTimeout  = 103,
  InvalidArguments    = 104,
  UnknownState        = 105,
}

const GOVERNOR_MESSAGES: Record<GovernorErrorCode, string> = {
  [GovernorErrorCode.UnauthorizedCancel]: "Unauthorized: only the proposer or guardian can cancel this proposal",
  [GovernorErrorCode.InvalidSupport]:     "Invalid vote support: this governance type does not allow abstain votes",
  [GovernorErrorCode.ProposalExpired]:    "Proposal has expired and can no longer be acted upon",
  [GovernorErrorCode.ProposalNotFound]:   "Proposal not found",
  [GovernorErrorCode.SimulationFailed]:   "Simulation failed",
  [GovernorErrorCode.TransactionFailed]:  "Transaction failed",
  [GovernorErrorCode.TransactionTimeout]: "Transaction timed out",
  [GovernorErrorCode.InvalidArguments]:   "Invalid arguments",
  [GovernorErrorCode.UnknownState]:       "Unknown proposal state",
};

export class GovernorError extends Error {
  readonly name = "GovernorError";

  constructor(
    public readonly code: GovernorErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, GovernorError.prototype);
  }
}

// ─── Timelock Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Timelock contract + SDK transport layer.
 *
 * Codes 1–99 mirror the on-chain TimelockError enum values.
 */
export enum TimelockErrorCode {
  // On-chain contract errors (match contracts/timelock/src/lib.rs)
  PredecessorNotDone  = 1,
  PredecessorNotFound = 2,
  OperationExpired    = 3,

  // SDK-level codes
  SimulationFailed   = 100,
  TransactionFailed  = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
}

const TIMELOCK_MESSAGES: Record<TimelockErrorCode, string> = {
  [TimelockErrorCode.PredecessorNotDone]:  "Cannot execute: predecessor operation has not been executed yet",
  [TimelockErrorCode.PredecessorNotFound]: "Cannot schedule: the specified predecessor operation does not exist",
  [TimelockErrorCode.OperationExpired]:    "Operation has expired and can no longer be executed",
  [TimelockErrorCode.SimulationFailed]:    "Simulation failed",
  [TimelockErrorCode.TransactionFailed]:   "Transaction failed",
  [TimelockErrorCode.TransactionTimeout]:  "Transaction timed out",
  [TimelockErrorCode.MissingReturnValue]:  "No return value from contract",
};

export class TimelockError extends Error {
  readonly name = "TimelockError";

  constructor(
    public readonly code: TimelockErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, TimelockError.prototype);
  }
}

// ─── Votes Errors ─────────────────────────────────────────────────────────────

/**
 * Error codes for the TokenVotes contract + SDK transport layer.
 *
 * The token-votes contract does not define a #[contracterror] enum, so all
 * codes here are SDK-level.
 */
export enum VotesErrorCode {
  SimulationFailed   = 100,
  TransactionFailed  = 101,
  TransactionTimeout = 102,
  DelegationFailed   = 103,
  EventScanFailed    = 104,
}

const VOTES_MESSAGES: Record<VotesErrorCode, string> = {
  [VotesErrorCode.SimulationFailed]:   "Simulation failed",
  [VotesErrorCode.TransactionFailed]:  "Transaction failed",
  [VotesErrorCode.TransactionTimeout]: "Transaction timed out",
  [VotesErrorCode.DelegationFailed]:   "Delegation transaction failed",
  [VotesErrorCode.EventScanFailed]:    "Failed to scan delegation events",
};

export class VotesError extends Error {
  readonly name = "VotesError";

  constructor(
    public readonly code: VotesErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, VotesError.prototype);
  }
}

// ─── Contract Error Parsing ───────────────────────────────────────────────────

/** Minimal shape of a Soroban RPC error result used by the parsers below. */
export interface SorobanRpcError {
  status?: string;
  error?: string;
  resultXdr?: string;
}

/**
 * Extract a numeric contract error code from a Soroban RPC error string.
 *
 * Handles the following formats emitted by Soroban RPC:
 * - `"Error(Contract, #3)"`
 * - `"HostError: Value(ContractError(3))"`
 * - `"contract error: #3"` (older RPC versions)
 */
export function extractContractErrorCode(raw: SorobanRpcError): number | null {
  const str = raw.error ?? "";

  // "Error(Contract, #3)"
  const hashMatch = str.match(/Error\(Contract,\s*#(\d+)\)/);
  if (hashMatch) return parseInt(hashMatch[1], 10);

  // "ContractError(3)" or "HostError: Value(ContractError(3))"
  const contractErrMatch = str.match(/ContractError\((\d+)\)/);
  if (contractErrMatch) return parseInt(contractErrMatch[1], 10);

  // "contract error: #3"
  const genericMatch = str.match(/contract error:\s*#?(\d+)/i);
  if (genericMatch) return parseInt(genericMatch[1], 10);

  return null;
}

/**
 * Parse a raw Soroban RPC error into a typed {@link GovernorError}.
 *
 * If the error string encodes a contract error code (e.g. `Error(Contract, #1)`)
 * the corresponding {@link GovernorErrorCode} and human-readable message are used.
 * Otherwise a generic transport-level code is assigned.
 */
export function parseGovernorError(
  raw: SorobanRpcError,
  cause?: unknown
): GovernorError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as GovernorErrorCode;
    const message =
      GOVERNOR_MESSAGES[code] ?? `Governor contract error #${contractCode}`;
    return new GovernorError(code, message, cause);
  }

  if (raw.status === "ERROR") {
    return new GovernorError(
      GovernorErrorCode.TransactionFailed,
      `${GOVERNOR_MESSAGES[GovernorErrorCode.TransactionFailed]}: ${raw.error ?? "unknown"}`,
      cause
    );
  }

  return new GovernorError(
    GovernorErrorCode.SimulationFailed,
    `${GOVERNOR_MESSAGES[GovernorErrorCode.SimulationFailed]}: ${raw.error ?? "unknown"}`,
    cause
  );
}

/**
 * Parse a raw Soroban RPC error into a typed {@link TimelockError}.
 */
export function parseTimelockError(
  raw: SorobanRpcError,
  cause?: unknown
): TimelockError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as TimelockErrorCode;
    const message =
      TIMELOCK_MESSAGES[code] ?? `Timelock contract error #${contractCode}`;
    return new TimelockError(code, message, cause);
  }

  if (raw.status === "ERROR") {
    return new TimelockError(
      TimelockErrorCode.TransactionFailed,
      `${TIMELOCK_MESSAGES[TimelockErrorCode.TransactionFailed]}: ${raw.error ?? "unknown"}`,
      cause
    );
  }

  return new TimelockError(
    TimelockErrorCode.SimulationFailed,
    `${TIMELOCK_MESSAGES[TimelockErrorCode.SimulationFailed]}: ${raw.error ?? "unknown"}`,
    cause
  );
}

// ─── Treasury Errors ──────────────────────────────────────────────────────────

/**
 * Error codes for the Treasury contract + SDK transport layer.
 *
 * Codes 1–99 mirror on-chain contract error values; SDK-level codes start at 100.
 */
export enum TreasuryErrorCode {
  // SDK-level codes
  SimulationFailed   = 100,
  TransactionFailed  = 101,
  TransactionTimeout = 102,
  MissingReturnValue = 103,
  InvalidArguments   = 104,
}

const TREASURY_MESSAGES: Record<TreasuryErrorCode, string> = {
  [TreasuryErrorCode.SimulationFailed]:   "Simulation failed",
  [TreasuryErrorCode.TransactionFailed]:  "Transaction failed",
  [TreasuryErrorCode.TransactionTimeout]: "Transaction timed out",
  [TreasuryErrorCode.MissingReturnValue]: "No return value from contract",
  [TreasuryErrorCode.InvalidArguments]:   "Invalid arguments",
};

export class TreasuryError extends Error {
  readonly name = "TreasuryError";

  constructor(
    public readonly code: TreasuryErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    Object.setPrototypeOf(this, TreasuryError.prototype);
  }
}

/**
 * Parse a raw Soroban RPC error into a typed {@link TreasuryError}.
 */
export function parseTreasuryError(
  raw: SorobanRpcError,
  cause?: unknown
): TreasuryError {
  const contractCode = extractContractErrorCode(raw);
  if (contractCode !== null) {
    const code = contractCode as TreasuryErrorCode;
    const message =
      TREASURY_MESSAGES[code] ?? `Treasury contract error #${contractCode}`;
    return new TreasuryError(code, message, cause);
  }

  if (raw.status === "ERROR") {
    return new TreasuryError(
      TreasuryErrorCode.TransactionFailed,
      `${TREASURY_MESSAGES[TreasuryErrorCode.TransactionFailed]}: ${raw.error ?? "unknown"}`,
      cause
    );
  }

  return new TreasuryError(
    TreasuryErrorCode.SimulationFailed,
    `${TREASURY_MESSAGES[TreasuryErrorCode.SimulationFailed]}: ${raw.error ?? "unknown"}`,
    cause
  );
}

/**
 * Parse a raw Soroban RPC error into a typed {@link VotesError}.
 */
export function parseVotesError(
  raw: SorobanRpcError,
  cause?: unknown
): VotesError {
  if (raw.status === "ERROR") {
    return new VotesError(
      VotesErrorCode.TransactionFailed,
      `${VOTES_MESSAGES[VotesErrorCode.TransactionFailed]}: ${raw.error ?? "unknown"}`,
      cause
    );
  }

  return new VotesError(
    VotesErrorCode.SimulationFailed,
    `${VOTES_MESSAGES[VotesErrorCode.SimulationFailed]}: ${raw.error ?? "unknown"}`,
    cause
  );
}
