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

/**
 * GovernorClient — interact with a deployed NebGov governor contract.
 *
 * TODO issue #14: add full error handling, retry logic, and simulation flow.
 *
 * @example
 * const client = new GovernorClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 * const id = await client.propose(
 *   keypair,
 *   "Upgrade protocol fee to 0.3%",
 *   "CAAAAA...",
 *   "upgrade",
 *   Buffer.from([0, 0, 1])
 * );
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
   * Create a new governance proposal.
   *
   * @param signer The account proposing the change
   * @param description A brief summary of the proposal
   * @param target The address of the contract to be called if the proposal passes
   * @param fnName The name of the function to call on the target
   * @param calldata The encoded arguments for the function call
   * @returns The unique identifier of the created proposal
   */
  async propose(
    signer: Keypair,
    description: string,
    target: string,
    fnName: string,
    calldata: Buffer | Uint8Array
  ): Promise<bigint> {
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
          nativeToScVal(target, { type: "address" }),
          nativeToScVal(fnName, { type: "symbol" }),
          nativeToScVal(calldata, { type: "bytes" })
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

    // Poll for confirmation
    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    return returnVal ? BigInt(scValToNative(returnVal)) : 0n;
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
