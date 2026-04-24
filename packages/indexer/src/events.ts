import { SorobanRpc, scValToNative } from "@stellar/stellar-sdk";
import { pool } from "./db";
import { invalidate, invalidatePattern } from "./cache";

export interface IndexerConfig {
  rpcUrl: string;
  governorAddress: string;
  wrapperAddress?: string;
  pollIntervalMs: number;
}

export async function getLastIndexedLedger(): Promise<number> {
  const res = await pool.query("SELECT last_ledger FROM indexer_state WHERE id = 1");
  return res.rows[0]?.last_ledger ?? 0;
}

export async function updateLastIndexedLedger(ledger: number): Promise<void> {
  await pool.query(
    "UPDATE indexer_state SET last_ledger = $1 WHERE id = 1",
    [ledger]
  );
}

export async function processEvents(
  server: SorobanRpc.Server,
  config: IndexerConfig,
  startLedger: number
): Promise<number> {
  let latestLedger = startLedger;

  try {
    const contractIds = [config.governorAddress].filter(Boolean);
    if (config.wrapperAddress) contractIds.push(config.wrapperAddress);

    const response = await server.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds,
        },
      ],
      limit: 200,
    });

    for (const event of response.events) {
      const ledger = event.ledger;
      if (ledger > latestLedger) latestLedger = ledger;

      const topics = event.topic.map((t) => scValToNative(t));
      const eventType = topics[0] as string;
      // Soroban EventResponse includes contractId for contract events.
      const contractId = (event as any).contractId as string | undefined;
      const isWrapper = !!(contractId && config.wrapperAddress && contractId === config.wrapperAddress);

      try {
        if (isWrapper) {
          switch (eventType) {
            case "deposit":
              await handleWrapperDeposit(event, topics);
              break;
            case "withdraw":
              await handleWrapperWithdraw(event, topics);
              break;
            case "delegate":
              await handleDelegateChanged(event, topics);
              break;
            default:
              break;
          }
        } else {
          switch (eventType) {
            case "prop_crtd":
              await handleProposalCreated(event, topics);
              break;
            case "vote":
              await handleVoteCast(event, topics, false);
              break;
            case "vote_rsn":
              await handleVoteCast(event, topics, true);
              break;
            case "queued":
              await handleProposalQueued(topics);
              break;
            case "executed":
              await handleProposalExecuted(topics);
              break;
            case "delegate":
              await handleDelegateChanged(event, topics);
              break;
            default:
              break;
          }
        }
      } catch (err) {
        console.error(`Failed to process event ${eventType}:`, err);
      }
    }
  } catch (err) {
    console.error("Error fetching events:", err);
  }

  return latestLedger;
}

async function handleProposalCreated(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[]
): Promise<void> {
  const proposer = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const [id, description, , , , startLedger, endLedger] = data as [
    bigint,
    string,
    unknown,
    unknown,
    unknown,
    number,
    number
  ];

  invalidatePattern("proposals:");
  await pool.query(
    `INSERT INTO proposals (id, proposer, description, start_ledger, end_ledger)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [String(id), proposer, description, startLedger, endLedger]
  );
  invalidate(`profile:${proposer}`);
}

async function handleVoteCast(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[],
  withReason: boolean
): Promise<void> {
  const voter = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const proposalId = String(data[0] as bigint);
  const support = Number(data[1]);
  const weight = String(withReason ? data[3] : data[2]);
  const reason = withReason ? String(data[2]) : null;

  // Upsert vote
  await pool.query(
    `INSERT INTO votes (proposal_id, voter, support, weight, reason, ledger)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (proposal_id, voter) DO UPDATE SET
       support = EXCLUDED.support,
       weight = EXCLUDED.weight,
       reason = COALESCE(EXCLUDED.reason, votes.reason)`,
    [proposalId, voter, support, weight, reason, event.ledger]
  );

  // Update proposal vote tallies
  const col = support === 1 ? "votes_for" : support === 0 ? "votes_against" : "votes_abstain";
  await pool.query(
    `UPDATE proposals SET ${col} = ${col} + $1 WHERE id = $2`,
    [weight, proposalId]
  );
  invalidate(`proposal_votes:${proposalId}`, `profile:${voter}`);
  invalidatePattern("proposals:");
}

async function handleProposalQueued(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET queued = true WHERE id = $1", [proposalId]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
}

async function handleProposalExecuted(topics: unknown[]): Promise<void> {
  const proposalId = String(topics[1] as bigint);
  await pool.query("UPDATE proposals SET executed = true WHERE id = $1", [proposalId]);
  invalidate(`proposal_votes:${proposalId}`);
  invalidatePattern("proposals:");
}

async function handleDelegateChanged(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[]
): Promise<void> {
  const delegator = topics[1] as string;
  const data = scValToNative(event.value) as [string, string];
  const [oldDelegatee, newDelegatee] = data;

  await pool.query(
    `INSERT INTO delegates (delegator, old_delegatee, new_delegatee, ledger)
     VALUES ($1, $2, $3, $4)`,
    [delegator, oldDelegatee, newDelegatee, event.ledger]
  );
  invalidatePattern("delegates:");
  invalidate(`profile:${delegator}`);
}

async function handleWrapperDeposit(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[]
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_deposits (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger]
  );
  invalidate(`profile:${account}`);
}

async function handleWrapperWithdraw(
  event: SorobanRpc.Api.EventResponse,
  topics: unknown[]
): Promise<void> {
  const account = topics[1] as string;
  const data = scValToNative(event.value) as unknown[];
  const amount = String(data[1] as bigint);

  await pool.query(
    `INSERT INTO wrapper_withdrawals (account, amount, ledger)
     VALUES ($1, $2, $3)`,
    [account, amount, event.ledger]
  );
  invalidate(`profile:${account}`);
}
