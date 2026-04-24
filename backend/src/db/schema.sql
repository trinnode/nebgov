-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(56) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Competitions table
CREATE TABLE IF NOT EXISTS competitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  entry_fee BIGINT DEFAULT 0,
  start_date TIMESTAMP NOT NULL,
  end_date TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Competition participants table
CREATE TABLE IF NOT EXISTS competition_participants (
  id SERIAL PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  entry_fee_paid BIGINT DEFAULT 0,
  UNIQUE(competition_id, user_id)
);

-- Leaderboard table
CREATE TABLE IF NOT EXISTS leaderboard (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score BIGINT DEFAULT 0,
  rank INTEGER,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

-- Leaderboard history table
CREATE TABLE IF NOT EXISTS leaderboard_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score BIGINT NOT NULL,
  rank INTEGER NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, snapshot_date)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_competition_participants_competition ON competition_participants(competition_id);
CREATE INDEX IF NOT EXISTS idx_competition_participants_user ON competition_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_rank ON leaderboard(rank);
CREATE INDEX IF NOT EXISTS idx_leaderboard_history_date ON leaderboard_history(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_leaderboard_history_user_date ON leaderboard_history(user_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_competitions_active ON competitions(is_active);
CREATE INDEX IF NOT EXISTS idx_competitions_dates ON competitions(start_date, end_date);

-- Notification preferences (per user)
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_self BOOLEAN DEFAULT true,
  active BOOLEAN DEFAULT true,
  voting_ends_soon BOOLEAN DEFAULT true,
  outcome BOOLEAN DEFAULT true,
  queued BOOLEAN DEFAULT true,
  executed BOOLEAN DEFAULT true
);

-- Notification history (per user)
CREATE TABLE IF NOT EXISTS notification_history (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  proposal_id BIGINT,
  message TEXT,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_history_user_created_at
  ON notification_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_history_user_read
  ON notification_history(user_id, read);
