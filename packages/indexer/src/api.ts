import express, { Request, Response } from "express";
import { pool } from "./db";

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // GET /proposals?offset=0&limit=20
  app.get("/proposals", async (req: Request, res: Response): Promise<void> => {
    const offset = Number(req.query.offset ?? 0);
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    try {
      const result = await pool.query(
        "SELECT * FROM proposals ORDER BY id DESC LIMIT $1 OFFSET $2",
        [limit, offset]
      );
      res.json({ proposals: result.rows, total: result.rowCount ?? 0 });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /proposals/:id/votes
  app.get("/proposals/:id/votes", async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        "SELECT * FROM votes WHERE proposal_id = $1 ORDER BY created_at DESC",
        [id]
      );
      res.json({ votes: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /delegates?top=20
  app.get("/delegates", async (req: Request, res: Response): Promise<void> => {
    const top = Math.min(Number(req.query.top ?? 20), 100);
    try {
      // Get most recent delegation per delegatee
      const result = await pool.query(
        `SELECT new_delegatee as address, COUNT(*) as delegator_count
         FROM delegates d1
         WHERE ledger = (
           SELECT MAX(d2.ledger) FROM delegates d2 WHERE d2.delegator = d1.delegator
         )
         GROUP BY new_delegatee
         ORDER BY delegator_count DESC
         LIMIT $1`,
        [top]
      );
      res.json({ delegates: result.rows });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /profile/:address
  app.get("/profile/:address", async (req: Request, res: Response): Promise<void> => {
    const { address } = req.params;
    try {
      const [proposalsRes, votesRes, delegationsRes] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM proposals WHERE proposer = $1", [address]),
        pool.query("SELECT COUNT(*), SUM(weight) FROM votes WHERE voter = $1", [address]),
        pool.query(
          "SELECT new_delegatee FROM delegates WHERE delegator = $1 ORDER BY ledger DESC LIMIT 1",
          [address]
        ),
      ]);

      res.json({
        address,
        proposalsCreated: Number(proposalsRes.rows[0].count),
        votescast: Number(votesRes.rows[0].count),
        totalVotingPowerUsed: String(votesRes.rows[0].sum ?? 0),
        currentDelegatee: delegationsRes.rows[0]?.new_delegatee ?? address,
      });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
