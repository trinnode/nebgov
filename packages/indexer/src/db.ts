import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://nebgov:nebgov@localhost:5432/nebgov",
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposals (
      id BIGINT PRIMARY KEY,
      proposer TEXT NOT NULL,
      description TEXT NOT NULL,
      start_ledger INT NOT NULL,
      end_ledger INT NOT NULL,
      votes_for BIGINT NOT NULL DEFAULT 0,
      votes_against BIGINT NOT NULL DEFAULT 0,
      votes_abstain BIGINT NOT NULL DEFAULT 0,
      executed BOOLEAN NOT NULL DEFAULT false,
      cancelled BOOLEAN NOT NULL DEFAULT false,
      queued BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      proposal_id BIGINT NOT NULL REFERENCES proposals(id),
      voter TEXT NOT NULL,
      support SMALLINT NOT NULL,
      weight BIGINT NOT NULL,
      reason TEXT,
      ledger INT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(proposal_id, voter)
    );

    CREATE TABLE IF NOT EXISTS delegates (
      id SERIAL PRIMARY KEY,
      delegator TEXT NOT NULL,
      old_delegatee TEXT NOT NULL,
      new_delegatee TEXT NOT NULL,
      ledger INT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wrapper_deposits (
      id SERIAL PRIMARY KEY,
      account TEXT NOT NULL,
      amount BIGINT NOT NULL,
      ledger INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wrapper_withdrawals (
      id SERIAL PRIMARY KEY,
      account TEXT NOT NULL,
      amount BIGINT NOT NULL,
      ledger INT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS indexer_state (
      id INT PRIMARY KEY DEFAULT 1,
      last_ledger INT NOT NULL DEFAULT 0
    );

    INSERT INTO indexer_state (id, last_ledger) VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;

    CREATE INDEX IF NOT EXISTS idx_proposals_created_at ON proposals(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_proposals_proposer ON proposals(proposer);

    CREATE INDEX IF NOT EXISTS idx_votes_proposal_id ON votes(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voter);

    CREATE INDEX IF NOT EXISTS idx_delegates_delegator ON delegates(delegator);
    CREATE INDEX IF NOT EXISTS idx_delegates_ledger ON delegates(ledger DESC);
    CREATE INDEX IF NOT EXISTS idx_delegates_new_delegatee ON delegates(new_delegatee);

    CREATE INDEX IF NOT EXISTS idx_wrapper_deposits_account ON wrapper_deposits(account);
    CREATE INDEX IF NOT EXISTS idx_wrapper_withdrawals_account ON wrapper_withdrawals(account);
  `);
}
