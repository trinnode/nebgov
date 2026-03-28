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
  Proposal,
  ProposalInput,
  ProposalState,
  ProposalVotes,
  VoteSupport,
  Network,
  UnknownProposalStateError,
} from "./types";

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

function scVecAddress(addrs: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addrs.map((a) => nativeToScVal(a, { type: "address" }))
  );
}

function scVecSymbol(syms: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    syms.map((s) => nativeToScVal(s.trim(), { type: "symbol" }))
  );
}

function scVecBytes(blobs: (Buffer | Uint8Array)[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    blobs.map((b) => nativeToScVal(b, { type: "bytes" }))
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
   * @param targets Calldata targets (same length as `fnNames` / `calldatas`)
   */
  async propose(
    signer: Keypair,
    description: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[]
  ): Promise<bigint> {
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new Error("targets, fnNames, and calldatas must have the same length");
    }
    if (targets.length === 0) {
      throw new Error("At least one on-chain action is required");
    }

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
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas)
        )
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
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<bigint> {
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new Error("targets, fnNames, and calldatas must have the same length");
    }
    if (targets.length === 0) {
      throw new Error("At least one on-chain action is required");
    }

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
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas)
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
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
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(this.contract.call("proposal_threshold"))
        .setTimeout(30)
        .build()
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
    args: xdr.ScVal[]
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
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(op)
        .setTimeout(30)
        .build()
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
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[]
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
  }> {
    try {
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
            scVecAddress(targets),
            scVecSymbol(fnNames),
            scVecBytes(calldatas)
          )
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
   * Cast a vote on an active proposal.
   */
  async castVote(
    signer: Keypair,
    proposalId: bigint,
    support: VoteSupport
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
          supportScVal
        )
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
   * Get the current state of a proposal.
   * TODO issue #17: decode all 7 ProposalState variants.
   */
  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call("state", nativeToScVal(proposalId, { type: "u64" }))
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
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(
          this.contract.call(
            "proposal_votes",
            nativeToScVal(proposalId, { type: "u64" })
          )
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

    const [votesFor, votesAgainst, votesAbstain] = scValToNative(raw) as [
      bigint,
      bigint,
      bigint
    ];
    return { votesFor, votesAgainst, votesAbstain };
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
    pollIntervalMs: number = 10_000
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
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
      )
        .addOperation(this.contract.call("proposal_count"))
        .setTimeout(30)
        .build()
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  // --- Internal ---

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000
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
}
