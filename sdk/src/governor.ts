import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  ExecutionGasEstimate,
  GovernorSettings,
  GovernorSettingsValidationLimits,
  Proposal,
  ProposalInput,
  ProposalState,
  ProposalVotes,
  VoteSupport,
  Network,
  UnknownProposalStateError,
} from "./types";
import { GovernorError, GovernorErrorCode } from "./errors";
import { hexToBytes32 } from "./utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const DEFAULT_MAX_VOTING_DELAY = 1_209_600;
const DEFAULT_MIN_VOTING_PERIOD = 1;

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

function simulationCostValue(
  cost: unknown,
  ...keys: string[]
): bigint | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const record = cost as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return toBigInt(value);
  }
  return undefined;
}

function scVecAddress(addrs: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addrs.map((a) => nativeToScVal(a, { type: "address" })),
  );
}

function scVecSymbol(syms: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    syms.map((s) => nativeToScVal(s.trim(), { type: "symbol" })),
  );
}

function scVecBytes(blobs: (Buffer | Uint8Array)[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    blobs.map((b) => nativeToScVal(b, { type: "bytes" })),
  );
}

/**
 * GovernorClient — interact with a deployed NebGov governor contract.
 *
 * TODO issue #14: add full error handling, retry logic, and simulation flow.
 */
export class GovernorClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.governorAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  /**
   * Create a new governance proposal (multi-action, matching on-chain `propose`).
   *
   * @param signer The account proposing the change
   * @param description A brief summary of the proposal
   * @param descriptionHash SHA-256 hash of the full description (hex string)
   * @param metadataUri URI pointing to the full description (ipfs:// or https://)
   * @param targets Calldata targets (same length as `fnNames` / `calldatas`)
   * @param fnNames Function names on each target
   * @param calldatas Encoded arguments for each call
   * @returns The unique identifier of the created proposal
   */
  async propose(
    signer: Keypair,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
  ): Promise<bigint> {
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new Error(
        "targets, fnNames, and calldatas must have the same length",
      );
    }
    if (targets.length === 0) {
      throw new Error("At least one on-chain action is required");
    }

    // Convert hex string to BytesN<32>
    const hashBytes = hexToBytes32(descriptionHash);

    const account = await this.server.getAccount(signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "propose",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(description, { type: "string" }),
          nativeToScVal(hashBytes, { type: "bytes" }),
          nativeToScVal(metadataUri, { type: "string" }),
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);

    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }

    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    return returnVal ? BigInt(scValToNative(returnVal)) : 0n;
  }

  /**
   * Same as {@link propose} but signs with a wallet callback (unsigned XDR in → signed XDR out).
   */
  async proposeWithSign(
    signerPublicKey: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<bigint> {
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new Error(
        "targets, fnNames, and calldatas must have the same length",
      );
    }
    if (targets.length === 0) {
      throw new Error("At least one on-chain action is required");
    }

    const hashBytes = hexToBytes32(descriptionHash);

    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "propose",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(description, { type: "string" }),
          nativeToScVal(hashBytes, { type: "bytes" }),
          nativeToScVal(metadataUri, { type: "string" }),
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }
    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    return returnVal ? BigInt(scValToNative(returnVal)) : 0n;
  }

  /** Minimum voting power required to create a proposal (`proposal_threshold`). */
  async proposalThreshold(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(this.contract.call("proposal_threshold"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw) as number | bigint | string) : 0n;
  }

  /**
   * Simulate a single contract invocation (for validating calldata before proposing).
   */
  async simulateTargetInvocation(
    footprintSourceAccount: string,
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
  }> {
    const target = new Contract(contractId);
    const op = target.call(functionName, ...args);
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(footprintSourceAccount),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(op)
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      const err = result as unknown as { error?: string };
      return { ok: false, error: err.error ?? "Simulation failed" };
    }
    const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      cost?: { cpuInsns?: string; memBytes?: string };
    };
    return {
      ok: true,
      cpuInsns: ok.cost?.cpuInsns,
      memBytes: ok.cost?.memBytes,
    };
  }

  /** Resource hints for the full `propose` transaction (simulation only). */
  async estimateProposeResources(
    proposer: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
  }> {
    try {
      const hashBytes = hexToBytes32(descriptionHash);
      const account = await this.server.getAccount(proposer);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "propose",
            nativeToScVal(proposer, { type: "address" }),
            nativeToScVal(description, { type: "string" }),
            nativeToScVal(hashBytes, { type: "bytes" }),
            nativeToScVal(metadataUri, { type: "string" }),
            scVecAddress(targets),
            scVecSymbol(fnNames),
            scVecBytes(calldatas),
          ),
        )
        .setTimeout(30)
        .build();

      const result = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(result)) {
        const err = result as unknown as { error?: string };
        return { ok: false, error: err.error ?? "Simulation failed" };
      }
      const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
        cost?: { cpuInsns?: string; memBytes?: string };
      };
      return {
        ok: true,
        cpuInsns: ok.cost?.cpuInsns,
        memBytes: ok.cost?.memBytes,
      };
    } catch (e: unknown) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "estimate failed",
      };
    }
  }

  /**
   * Simulate the governor's `estimate_execution_gas` view and return its cost hint.
   *
   * `sourceAccount` should be any funded account on the selected network. If it
   * is omitted, the client falls back to the configured governor address for
   * compatibility with existing SDK read methods.
   */
  async estimateExecutionGas(
    proposalId: bigint,
    sourceAccount: string = this.config.governorAddress,
  ): Promise<ExecutionGasEstimate> {
    const account = await this.server.getAccount(sourceAccount);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "estimate_execution_gas",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
      cost?: Record<string, unknown>;
    };
    const raw = success.result?.retval;
    if (!raw) throw new Error("No return value");

    const native = scValToNative(raw) as Record<string, unknown>;
    return {
      proposalId: toBigInt(native.proposal_id ?? native.proposalId),
      actionCount: Number(native.action_count ?? native.actionCount ?? 0),
      calldataBytes: Number(native.calldata_bytes ?? native.calldataBytes ?? 0),
      estimatedCpuInsns: toBigInt(
        native.estimated_cpu_insns ?? native.estimatedCpuInsns,
      ),
      estimatedMemBytes: toBigInt(
        native.estimated_mem_bytes ?? native.estimatedMemBytes,
      ),
      estimatedFeeStroops: toBigInt(
        native.estimated_fee_stroops ?? native.estimatedFeeStroops,
      ),
      rpcCpuInsns: simulationCostValue(
        success.cost,
        "cpuInsns",
        "cpuInstructions",
      ),
      rpcMemBytes: simulationCostValue(success.cost, "memBytes", "memoryBytes"),
    };
  }

  /**
   * Cast a vote on an active proposal.
   */
  async castVote(
    signer: Keypair,
    proposalId: bigint,
    support: VoteSupport,
  ): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cast_vote",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal,
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`castVote failed: ${JSON.stringify(result)}`);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Same as {@link castVote} but signs with a wallet callback.
   */
  async castVoteWithSign(
    signerPublicKey: string,
    proposalId: bigint,
    support: VoteSupport,
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cast_vote",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`castVoteWithSign failed: ${JSON.stringify(result)}`);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Get the current state of a proposal.
   * TODO issue #17: decode all 7 ProposalState variants.
   */
  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(
          this.contract.call(
            "state",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    return this.decodeProposalState(raw);
  }

  /**
   * Decode the Soroban enum ScVal (vector-wrapped symbol) to ProposalState.
   */
  private decodeProposalState(raw: xdr.ScVal): ProposalState {
    const native = scValToNative(raw);
    if (!Array.isArray(native) || native.length === 0) {
      throw new Error("Invalid ScVal format for ProposalState enum");
    }

    const variant = native[0];
    const states: Record<string, ProposalState> = {
      Pending: ProposalState.Pending,
      Active: ProposalState.Active,
      Defeated: ProposalState.Defeated,
      Succeeded: ProposalState.Succeeded,
      Queued: ProposalState.Queued,
      Executed: ProposalState.Executed,
      Cancelled: ProposalState.Cancelled,
    };

    // DEBUG: throw info

    if (variant in states) {
      return states[variant];
    }

    throw new UnknownProposalStateError(variant);
  }

  /**
   * Get vote breakdown for a proposal.
   */
  async getProposalVotes(proposalId: bigint): Promise<ProposalVotes> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(
          this.contract.call(
            "proposal_votes",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    const [votesFor, votesAgainst, votesAbstain] = scValToNative(raw) as [
      bigint,
      bigint,
      bigint,
    ];
    return { votesFor, votesAgainst, votesAbstain };
  }

  /**
   * Check if an address has voted on a proposal.
   * Returns true if the address has cast a vote.
   */
  async hasVoted(proposalId: bigint, voter: string): Promise<boolean> {
    try {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.config.governorAddress),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
        )
          .addOperation(
            this.contract.call(
              "has_voted",
              nativeToScVal(proposalId, { type: "u64" }),
              nativeToScVal(voter, { type: "address" })
            )
          )
          .setTimeout(30)
          .build()
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        return false;
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? Boolean(scValToNative(raw)) : false;
    } catch {
      return false;
    }
  }

  /** Current Soroban ledger sequence from the RPC backing this client. */
  async getLatestLedger(): Promise<number> {
    const info = await this.server.getLatestLedger();
    return info.sequence;
  }

  /**
   * Poll `getProposalState` until the state changes (compared to the prior poll).
   *
   * The first successful poll establishes a baseline and does **not** invoke `onChange`.
   * Unsubscribe with the returned function to stop polling.
   */
  onProposalStateChange(
    proposalId: bigint,
    onChange: (newState: ProposalState) => void,
    pollIntervalMs: number = 10_000,
  ): () => void {
    let stopped = false;
    let previous: ProposalState | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const state = await this.getProposalState(proposalId);
        if (previous !== undefined && state !== previous) {
          onChange(state);
        }
        previous = state;
      } catch {
        // Transient RPC errors — retry on next tick
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), pollIntervalMs);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  /**
   * Get total number of proposals.
   */
  async proposalCount(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(this.contract.call("proposal_count"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get the voting receipt for a specific voter on a proposal.
   *
   * Returns whether the voter has voted, their support choice, vote weight, and reason.
   */
  async getReceipt(
    proposalId: bigint,
    voter: string,
  ): Promise<{
    hasVoted: boolean;
    support: VoteSupport;
    weight: bigint;
    reason: string;
  }> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(
          this.contract.call(
            "get_receipt",
            nativeToScVal(proposalId, { type: "u64" }),
            nativeToScVal(voter, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      return {
        hasVoted: false,
        support: VoteSupport.Against,
        weight: 0n,
        reason: "",
      };
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) {
      return {
        hasVoted: false,
        support: VoteSupport.Against,
        weight: 0n,
        reason: "",
      };
    }

    const receipt = scValToNative(raw) as {
      has_voted: boolean;
      support: string[];
      weight: bigint;
      reason: string;
    };

    // Decode support enum (vector-wrapped symbol)
    const supportMap: Record<string, VoteSupport> = {
      Against: VoteSupport.Against,
      For: VoteSupport.For,
      Abstain: VoteSupport.Abstain,
    };
    const supportVariant = receipt.support[0];
    const support = supportMap[supportVariant] ?? VoteSupport.Against;

    return {
      hasVoted: receipt.has_voted,
      support,
      weight: BigInt(receipt.weight),
      reason: receipt.reason,
    };
  }

  /**
   * Validate settings before building or submitting an update_config proposal.
   */
  validateGovernorSettings(
    newSettings: GovernorSettings,
    limits: GovernorSettingsValidationLimits = {},
  ): void {
    const maxVotingDelay = limits.maxVotingDelay ?? DEFAULT_MAX_VOTING_DELAY;
    const minVotingPeriod = limits.minVotingPeriod ?? DEFAULT_MIN_VOTING_PERIOD;

    if (
      !Number.isInteger(newSettings.votingDelay) ||
      newSettings.votingDelay < 0 ||
      newSettings.votingDelay > maxVotingDelay
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        `votingDelay must be between 0 and ${maxVotingDelay}`,
      );
    }
    if (
      !Number.isInteger(newSettings.votingPeriod) ||
      newSettings.votingPeriod < minVotingPeriod
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        `votingPeriod must be at least ${minVotingPeriod}`,
      );
    }
    if (
      !Number.isInteger(newSettings.quorumNumerator) ||
      newSettings.quorumNumerator <= 0 ||
      newSettings.quorumNumerator > 100
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        "quorumNumerator must be greater than 0 and at most 100",
      );
    }
    if (newSettings.proposalThreshold < 0n) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        "proposalThreshold must be greater than or equal to 0",
      );
    }
  }

  /**
   * Build calldata for an update_config proposal.
   *
   * Returns the target, function name, and encoded calldata to pass to propose().
   */
  buildUpdateConfigProposal(
    newSettings: GovernorSettings,
    limits: GovernorSettingsValidationLimits = {},
  ): {
    target: string;
    fnName: string;
    calldata: Uint8Array;
  } {
    this.validateGovernorSettings(newSettings, limits);
    const useDynamicQuorum = newSettings.useDynamicQuorum ?? false;
    const minQuorumUsd = newSettings.minQuorumUsd ?? 0n;
    const maxCalldataSize = newSettings.maxCalldataSize ?? 10_000;
    const proposalCooldown = newSettings.proposalCooldown ?? 100;
    const maxProposalsPerPeriod = newSettings.maxProposalsPerPeriod ?? 5;
    const proposalPeriodDuration = newSettings.proposalPeriodDuration ?? 10_000;

    const settingsScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("voting_delay"),
        val: nativeToScVal(newSettings.votingDelay, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("voting_period"),
        val: nativeToScVal(newSettings.votingPeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("quorum_numerator"),
        val: nativeToScVal(newSettings.quorumNumerator, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_threshold"),
        val: nativeToScVal(newSettings.proposalThreshold, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("guardian"),
        val: nativeToScVal(newSettings.guardian, { type: "address" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("vote_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newSettings.voteType)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_grace_period"),
        val: nativeToScVal(newSettings.proposalGracePeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("use_dynamic_quorum"),
        val: xdr.ScVal.scvBool(useDynamicQuorum),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("reflector_oracle"),
        val: newSettings.reflectorOracle
          ? nativeToScVal(newSettings.reflectorOracle, { type: "address" })
          : xdr.ScVal.scvVoid(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("min_quorum_usd"),
        val: nativeToScVal(minQuorumUsd, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("max_calldata_size"),
        val: nativeToScVal(maxCalldataSize, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_cooldown"),
        val: nativeToScVal(proposalCooldown, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("max_proposals_per_period"),
        val: nativeToScVal(maxProposalsPerPeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_period_duration"),
        val: nativeToScVal(proposalPeriodDuration, { type: "u32" }),
      }),
    ]);

    return {
      target: this.config.governorAddress,
      fnName: "update_config",
      calldata: settingsScVal.toXDR(),
    };
  }

  // --- Internal ---

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${hash}`);
      }
    }
    throw new Error(`Transaction not confirmed after ${retries} retries`);
  }

  /**
   * Fetch a proposal by its ID.
   */
  async getProposal(proposalId: bigint): Promise<Proposal> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call("get_proposal", nativeToScVal(proposalId, { type: "u64" }))
        )
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    return scValToNative(raw) as Proposal;
  }
}

/**
 * Compute SHA-256 hash of a proposal description.
 *
 * This function uses the Web Crypto API in browser environments and
 * Node.js crypto module in server-side environments. The input is
 * UTF-8 encoded before hashing, and the output is a 64-character
 * lowercase hex string.
 *
 * @param text - The proposal description text to hash
 * @returns Hex-encoded SHA-256 hash (64 lowercase characters)
 */
export async function hashDescription(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Use Web Crypto API (available in both browser and Node.js 18+)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback to Node.js crypto module
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("No crypto API available in this environment");
}

/**
 * Synchronous version of hashDescription for environments where async is not needed.
 * Uses the same algorithm and encoding.
 */
export function hashDescriptionSync(text: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Try Node.js crypto first (synchronous)
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("Synchronous SHA-256 is only available in Node.js environments. Use async hashDescription instead.");
}
