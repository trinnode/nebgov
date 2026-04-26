import express, { Request, Response } from "express";
import { SorobanRpc } from "@stellar/stellar-sdk";
import { pool } from "./db";
import { cached, getMetrics } from "./cache";
import { getLastIndexedLedger } from "./events";
import { startTime } from "./index";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";

const TTL = {
  proposals: 30_000, // 30 seconds
  proposalVotes: 15_000, // 15 seconds
  delegates: 60_000, // 60 seconds
  profile: 30_000, // 30 seconds
};

const HEALTH_LAG_THRESHOLD = Number(process.env.HEALTH_LAG_THRESHOLD ?? 100);
const STELLAR_LEDGER_CLOSE_TIME_SECONDS = 5; // Stellar ledgers close approximately every 5 seconds

interface HealthResponse {
  status: "ok" | "degraded";
  last_indexed_ledger: number;
  current_ledger: number;
  lag_ledgers: number;
  lag_seconds: number;
  total_proposals_indexed: number;
  total_votes_indexed: number;
  total_delegates_indexed: number;
  uptime_seconds: number;
  timestamp: string;
}

async function getHealthStatus(server: SorobanRpc.Server): Promise<HealthResponse> {
  // Fetch current ledger from RPC
  const latestLedger = await server.getLatestLedger();
  const currentLedger = latestLedger.sequence;

  // Get last indexed ledger from database
  const lastIndexedLedger = await getLastIndexedLedger();

  // Calculate lag
  const lagLedgers = Math.max(0, currentLedger - lastIndexedLedger);
  const lagSeconds = lagLedgers * STELLAR_LEDGER_CLOSE_TIME_SECONDS;

  // Get counts from database
  const [proposalsResult, votesResult, delegatesResult] = await Promise.all([
    pool.query("SELECT COUNT(*) as count FROM proposals"),
    pool.query("SELECT COUNT(*) as count FROM votes"),
    pool.query("SELECT COUNT(DISTINCT delegator) as count FROM delegates"),
  ]);

  const totalProposals = Number(proposalsResult.rows[0]?.count ?? 0);
  const totalVotes = Number(votesResult.rows[0]?.count ?? 0);
  const totalDelegates = Number(delegatesResult.rows[0]?.count ?? 0);

  // Calculate uptime
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Determine status
  const status = lagLedgers > HEALTH_LAG_THRESHOLD ? "degraded" : "ok";

  return {
    status,
    last_indexed_ledger: lastIndexedLedger,
    current_ledger: currentLedger,
    lag_ledgers: lagLedgers,
    lag_seconds: lagSeconds,
    total_proposals_indexed: totalProposals,
    total_votes_indexed: totalVotes,
    total_delegates_indexed: totalDelegates,
    uptime_seconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
  };
}

export function createApp(server: SorobanRpc.Server): express.Application {
  const app = express();
  app.use(express.json());

  // Swagger documentation
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(generateOpenApiDocument());
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));

  // GET /health
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await getHealthStatus(server);
      const httpStatus = health.status === "ok" ? 200 : 503;
      res.status(httpStatus).json(health);
    } catch (error) {
      console.error("Health check error:", error);
      res.status(503).json({
        status: "degraded",
        error: "Failed to retrieve health status",
        timestamp: new Date().toISOString(),
      });
    }
  });

  // GET /proposals?offset=0&limit=20
  app.get("/proposals", async (req: Request, res: Response): Promise<void> => {
    const offset = Number(req.query.offset ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const key = `proposals:${offset}:${limit}`;
    try {
      const data = await cached(key, TTL.proposals, async () => {
        const result = await pool.query(
          "SELECT * FROM proposals ORDER BY id DESC LIMIT $1 OFFSET $2",
          [limit, offset],
        );
        return { proposals: result.rows, total: result.rowCount ?? 0 };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/:id/votes
  app.get(
    "/proposals/:id/votes",
    async (req: Request, res: Response): Promise<void> => {
      const { id } = req.params;
      const key = `proposal_votes:${id}`;
      try {
        const data = await cached(key, TTL.proposalVotes, async () => {
          const result = await pool.query(
            "SELECT * FROM votes WHERE proposal_id = $1 ORDER BY created_at DESC",
            [id],
          );
          return { votes: result.rows };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /delegates?top=20
  app.get("/delegates", async (req: Request, res: Response): Promise<void> => {
    const top = Math.min(Number(req.query.top ?? 20), 100);
    const key = `delegates:${top}`;
    try {
      const data = await cached(key, TTL.delegates, async () => {
        const result = await pool.query(
          `SELECT new_delegatee as address, COUNT(*) as delegator_count
           FROM delegates d1
           WHERE ledger = (
             SELECT MAX(d2.ledger) FROM delegates d2 WHERE d2.delegator = d1.delegator
           )
           GROUP BY new_delegatee
           ORDER BY delegator_count DESC
           LIMIT $1`,
          [top],
        );
        return { delegates: result.rows };
      });
      res.json(data);
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /profile/:address
  app.get(
    "/profile/:address",
    async (req: Request, res: Response): Promise<void> => {
      const { address } = req.params;
      const key = `profile:${address}`;
      try {
        const data = await cached(key, TTL.profile, async () => {
          const [
            proposalsRes,
            votesRes,
            delegationsRes,
            wrapperDepositsRes,
            wrapperWithdrawalsRes,
          ] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM proposals WHERE proposer = $1", [
              address,
            ]),
            pool.query(
              "SELECT COUNT(*), SUM(weight) FROM votes WHERE voter = $1",
              [address],
            ),
            pool.query(
              "SELECT new_delegatee FROM delegates WHERE delegator = $1 ORDER BY ledger DESC LIMIT 1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_deposits WHERE account = $1",
              [address],
            ),
            pool.query(
              "SELECT COALESCE(SUM(amount), 0) AS sum FROM wrapper_withdrawals WHERE account = $1",
              [address],
            ),
          ]);

          const depositTotal = BigInt(wrapperDepositsRes.rows[0]?.sum ?? 0);
          const withdrawalTotal = BigInt(
            wrapperWithdrawalsRes.rows[0]?.sum ?? 0,
          );
          const wrappedBalance = depositTotal - withdrawalTotal;

          return {
            address,
            proposalsCreated: Number(proposalsRes.rows[0].count),
            votescast: Number(votesRes.rows[0].count),
            totalVotingPowerUsed: String(votesRes.rows[0].sum ?? 0),
            currentDelegatee: delegationsRes.rows[0]?.new_delegatee ?? address,
            wrapper: {
              depositTotal: depositTotal.toString(),
              withdrawalTotal: withdrawalTotal.toString(),
              wrappedBalance: wrappedBalance.toString(),
            },
          };
        });
        res.json(data);
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/deposits?account=G...&limit&offset
  app.get(
    "/wrapper/deposits",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_deposits ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /wrapper/withdrawals?account=G...&limit&offset
  app.get(
    "/wrapper/withdrawals",
    async (req: Request, res: Response): Promise<void> => {
      const account =
        typeof req.query.account === "string" ? req.query.account : undefined;
      const limit = Math.min(Number(req.query.limit ?? 50), 200);
      const offset = Number(req.query.offset ?? 0);
      try {
        const params: any[] = [];
        let where = "";
        if (account) {
          where = "WHERE account = $1";
          params.push(account);
        }
        params.push(limit, offset);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const result = await pool.query(
          `SELECT * FROM wrapper_withdrawals ${where} ORDER BY ledger DESC, id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
          params,
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // GET /treasury/transfers?limit&offset — paginated treasury batch transfer history
  app.get(
    "/treasury/transfers",
    async (req: Request, res: Response): Promise<void> => {
      const limit = Math.min(Number(req.query.limit ?? 20), 100);
      const offset = Number(req.query.offset ?? 0);
      try {
        const result = await pool.query(
          `SELECT * FROM treasury_transfers ORDER BY ledger DESC, id DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        );
        res.json({
          data: result.rows,
          pagination: { limit, offset, hasMore: result.rows.length === limit },
        });
      } catch {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return app;
}
