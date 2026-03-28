import {
  SorobanRpc,
  xdr,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Network } from "./types";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

/**
 * Default polling interval in milliseconds.
 *
 * Soroban ledgers close roughly every 5–6 seconds on testnet. A 10-second
 * interval keeps RPC traffic low while still delivering near-real-time
 * updates. Pass a custom `intervalMs` to any subscription helper to override.
 */
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** Shape of a raw Soroban contract event returned by `getEvents`. */
export interface SorobanEvent {
  /** Ledger sequence the event was emitted in */
  ledger: number;
  /** Contract that emitted the event */
  contractId: string;
  /** Decoded topic segments (symbol strings) */
  topic: string[];
  /** Decoded event body value */
  value: unknown;
}

/** Decoded `prop_crtd` proposal-created event (NebGov governor). */
export interface ProposalCreatedEventData {
  proposalId: bigint;
  /** Proposer account strkey from the event topic */
  proposer: string;
  startLedger: number;
  endLedger: number;
}

export function parseProposalCreatedEvent(
  event: SorobanEvent
): ProposalCreatedEventData | null {
  if (event.topic[0] !== "prop_crtd" || event.topic.length < 2) return null;
  const proposer = String(event.topic[1]);
  const raw = event.value;
  if (!Array.isArray(raw) || raw.length < 7) return null;
  try {
    const proposalId = BigInt(raw[0] as number | bigint | string);
    const startLedger = Number(raw[5]);
    const endLedger = Number(raw[6]);
    return { proposalId, proposer, startLedger, endLedger };
  } catch {
    return null;
  }
}

export function parseProposalQueuedEvent(
  event: SorobanEvent
): { proposalId: bigint; readyAt: bigint } | null {
  if (event.topic[0] !== "ProposalQueued") return null;
  const raw = event.value;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  try {
    return {
      proposalId: BigInt(raw[0] as number | bigint | string),
      readyAt: BigInt(raw[1] as number | bigint | string),
    };
  } catch {
    return null;
  }
}

export function parseProposalExecutedEvent(event: SorobanEvent): bigint | null {
  if (event.topic[0] !== "execute") return null;
  const v = event.value;
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(v);
    return BigInt(v as number | bigint | string);
  } catch {
    return null;
  }
}

/** Options shared by all subscription helpers. */
export interface SubscriptionOptions {
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public endpoint) */
  rpcUrl?: string;
  /**
   * Polling interval in milliseconds.
   * @default 10_000
   */
  intervalMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildServer(opts: SubscriptionOptions): SorobanRpc.Server {
  const rpcUrl = opts.rpcUrl ?? RPC_URLS[opts.network];
  return new SorobanRpc.Server(rpcUrl, { allowHttp: false });
}

/**
 * Decode a single raw event from the `getEvents` response into a
 * friendly {@link SorobanEvent} shape.
 */
function decodeEvent(
  raw: SorobanRpc.Api.EventResponse
): SorobanEvent {
  const topic = raw.topic.map((t) => scValToNative(t) as string);
  const value = scValToNative(raw.value);

  return {
    ledger: raw.ledger,
    contractId: raw.contractId?.contractId() ?? "",
    topic,
    value,
  };
}

/**
 * Fetch events from the Soroban RPC matching the given filters, starting
 * from `startLedger`. Returns the decoded events **and** the latest ledger
 * seen so the caller can paginate forward.
 */
export async function fetchEvents(
  server: SorobanRpc.Server,
  contractId: string,
  topicFilter: xdr.ScVal[],
  startLedger: number
): Promise<{ events: SorobanEvent[]; latestLedger: number }> {
  const response = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [contractId],
        topics: [topicFilter.map((v) => v.toXDR("base64"))],
      },
    ],
    limit: 100,
  });

  const events = (response.events ?? []).map(decodeEvent);
  const latestLedger = response.latestLedger
    ? Number(response.latestLedger)
    : startLedger;

  return { events, latestLedger };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribe to new `prop_crtd` (proposal created) events from the governor contract.
 *
 * Polls `SorobanRpc.Server.getEvents()` on the given interval and invokes
 * `callback` for every new proposal event discovered.
 *
 * **Cleaning up:** call the returned function to stop polling.
 *
 * @param governorAddress - Strkey contract address of the governor
 * @param callback        - Invoked with each decoded proposal event
 * @param opts            - Network, optional RPC URL, and polling interval
 * @returns An unsubscribe function — call it to stop polling
 *
 * @example
 * ```ts
 * const unsub = subscribeToProposals(
 *   "CABC...",
 *   (event) => console.log("New proposal!", event),
 *   { network: "testnet" },
 * );
 * // later…
 * unsub();
 * ```
 */
export function subscribeToProposals(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [xdr.ScVal.scvSymbol("prop_crtd")];

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );

      for (const event of events) {
        if (!stopped) callback(event);
      }

      // Move cursor past the events we already processed
      cursor = latestLedger + 1;
    } catch {
      // Silently retry on transient RPC errors; consumer can monitor via
      // their own error boundary or logging.
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  // Kick off the first poll immediately
  void poll();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Subscribe to `vote` events on a specific proposal.
 *
 * Polls `getEvents` with the `vote` topic (first segment). On-chain vote events
 * use `(vote, voter)` topics, so proposal id is taken from the event body and
 * matched against `proposalId`.
 *
 * **Cleaning up:** call the returned function to stop polling.
 *
 * @param governorAddress - Strkey contract address of the governor
 * @param proposalId      - The proposal to watch for votes
 * @param callback        - Invoked with each decoded vote event
 * @param opts            - Network, optional RPC URL, and polling interval
 * @returns An unsubscribe function — call it to stop polling
 *
 * @example
 * ```ts
 * const unsub = subscribeToVotes(
 *   "CABC...",
 *   1n,
 *   (event) => console.log("Vote cast!", event),
 *   { network: "testnet" },
 * );
 * // later…
 * unsub();
 * ```
 */
export function subscribeToVotes(
  governorAddress: string,
  proposalId: bigint,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [xdr.ScVal.scvSymbol("vote")];
  const wantId = proposalId;

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;

    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }

      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );

      for (const event of events) {
        if (stopped) break;
        const body = event.value;
        const pid =
          Array.isArray(body) && body.length > 0
            ? BigInt(body[0] as number | bigint | string)
            : null;
        if (pid === wantId) callback(event);
      }

      cursor = latestLedger + 1;
    } catch {
      // Silently retry on transient RPC errors
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  void poll();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Fetch historical `prop_crtd` (proposal created) events from a governor contract.
 * Paginates until the current ledger so large ranges are fully covered.
 */
export async function getProposalEvents(
  governorAddress: string,
  fromLedger: number,
  opts: SubscriptionOptions
): Promise<SorobanEvent[]> {
  const server = buildServer(opts);
  const topicFilter = [xdr.ScVal.scvSymbol("prop_crtd")];
  const latest = (await server.getLatestLedger()).sequence;
  const out: SorobanEvent[] = [];
  let start = Math.max(1, fromLedger);

  while (start <= latest) {
    const { events, latestLedger } = await fetchEvents(
      server,
      governorAddress,
      topicFilter,
      start
    );
    if (events.length === 0) {
      start = latestLedger + 1;
      continue;
    }
    out.push(...events);
    start = Math.max(...events.map((e) => e.ledger)) + 1;
  }

  return out;
}

/**
 * Subscribe to `ProposalQueued` events for the governor contract.
 */
export function subscribeToProposalQueued(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [xdr.ScVal.scvSymbol("ProposalQueued")];

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }
      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );
      for (const event of events) {
        if (!stopped) callback(event);
      }
      cursor = latestLedger + 1;
    } catch {
      /* retry */
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  void poll();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Subscribe to `execute` events (proposal executed) for the governor contract.
 */
export function subscribeToProposalExecuted(
  governorAddress: string,
  callback: (event: SorobanEvent) => void,
  opts: SubscriptionOptions
): () => void {
  const server = buildServer(opts);
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const topicFilter = [xdr.ScVal.scvSymbol("execute")];

  let cursor = 0;
  let initialized = false;
  let stopped = false;

  async function poll(): Promise<void> {
    if (stopped) return;
    try {
      if (!initialized) {
        const info = await server.getLatestLedger();
        cursor = info.sequence;
        initialized = true;
      }
      const { events, latestLedger } = await fetchEvents(
        server,
        governorAddress,
        topicFilter,
        cursor
      );
      for (const event of events) {
        if (!stopped) callback(event);
      }
      cursor = latestLedger + 1;
    } catch {
      /* retry */
    }
  }

  const handle = setInterval(() => void poll(), intervalMs);
  void poll();
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
