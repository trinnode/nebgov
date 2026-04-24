import { Response, Router } from "express";
import { body, query, validationResult } from "express-validator";
import pool from "../db/pool";
import { authenticate, AuthRequest } from "../middleware/auth";

const router = Router();

const PREF_KEYS = [
  "created_self",
  "active",
  "voting_ends_soon",
  "outcome",
  "queued",
  "executed",
] as const;

type PrefKey = (typeof PREF_KEYS)[number];

function defaultPreferences() {
  return {
    created_self: true,
    active: true,
    voting_ends_soon: true,
    outcome: true,
    queued: true,
    executed: true,
  };
}

// GET /notifications/preferences - get current preferences (auth required)
router.get("/preferences", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId!;
    const result = await pool.query(
      `SELECT ${PREF_KEYS.join(", ")} FROM notification_preferences WHERE user_id = $1`,
      [userId],
    );
    res.json(result.rows[0] ?? defaultPreferences());
  } catch (error) {
    console.error("Error fetching notification preferences:", error);
    res.status(500).json({ error: "Failed to fetch preferences" });
  }
});

// POST /notifications/preferences - save preferences (auth required)
router.post(
  "/preferences",
  authenticate,
  ...PREF_KEYS.map((k) => body(k).optional().isBoolean()),
  async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.userId!;
    const next: Record<PrefKey, boolean> = defaultPreferences();
    for (const k of PREF_KEYS) {
      if (typeof req.body[k] === "boolean") next[k] = req.body[k];
    }

    try {
      await pool.query(
        `INSERT INTO notification_preferences (user_id, ${PREF_KEYS.join(", ")})
         VALUES ($1, ${PREF_KEYS.map((_, i) => `$${i + 2}`).join(", ")})
         ON CONFLICT (user_id) DO UPDATE SET
           ${PREF_KEYS.map((k, i) => `${k} = $${i + 2}`).join(", ")}`,
        [userId, ...PREF_KEYS.map((k) => next[k])],
      );

      res.json(next);
    } catch (error) {
      console.error("Error saving notification preferences:", error);
      res.status(500).json({ error: "Failed to save preferences" });
    }
  },
);

// GET /notifications - fetch user's notification history (auth required)
router.get(
  "/",
  authenticate,
  [
    query("limit").optional().isInt({ min: 1, max: 200 }).toInt(),
    query("offset").optional().isInt({ min: 0 }).toInt(),
    query("unread_only").optional().isBoolean().toBoolean(),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.userId!;
    const limit = (req.query.limit as number | undefined) ?? 100;
    const offset = (req.query.offset as number | undefined) ?? 0;
    const unreadOnly = (req.query.unread_only as boolean | undefined) ?? false;

    try {
      const whereUnread = unreadOnly ? "AND read = false" : "";
      const rows = await pool.query(
        `SELECT id, type, proposal_id, message, read, created_at
         FROM notification_history
         WHERE user_id = $1 ${whereUnread}
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total,
                SUM(CASE WHEN read = false THEN 1 ELSE 0 END)::int AS unread
         FROM notification_history
         WHERE user_id = $1`,
        [userId],
      );

      res.json({
        data: rows.rows,
        meta: {
          total: count.rows[0]?.total ?? 0,
          unread: count.rows[0]?.unread ?? 0,
          limit,
          offset,
        },
      });
    } catch (error) {
      console.error("Error fetching notification history:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  },
);

// POST /notifications - add a history entry (auth required)
router.post(
  "/",
  authenticate,
  body("type").isString().trim().isLength({ min: 1, max: 64 }),
  body("proposal_id").optional().isInt({ min: 0 }).toInt(),
  body("message").optional().isString(),
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.userId!;
    const type = (req.body.type as string).trim();
    const proposalId = req.body.proposal_id as number | undefined;
    const message = (req.body.message as string | undefined) ?? null;

    try {
      const inserted = await pool.query(
        `INSERT INTO notification_history (user_id, type, proposal_id, message)
         VALUES ($1, $2, $3, $4)
         RETURNING id, type, proposal_id, message, read, created_at`,
        [userId, type, proposalId ?? null, message],
      );
      res.status(201).json(inserted.rows[0]);
    } catch (error) {
      console.error("Error inserting notification:", error);
      res.status(500).json({ error: "Failed to create notification" });
    }
  },
);

// POST /notifications/mark-read - mark notifications as read (auth required)
router.post(
  "/mark-read",
  authenticate,
  body("ids").optional().isArray({ min: 1 }),
  body("ids.*").optional().isInt().toInt(),
  body("all").optional().isBoolean(),
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.userId!;
    const markAll = req.body.all === true;
    const ids = (req.body.ids as number[] | undefined) ?? [];

    try {
      if (markAll) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND read = false",
          [userId],
        );
      } else if (ids.length > 0) {
        await pool.query(
          "UPDATE notification_history SET read = true WHERE user_id = $1 AND id = ANY($2::int[])",
          [userId, ids],
        );
      }

      const unread = await pool.query(
        "SELECT COUNT(*)::int AS unread FROM notification_history WHERE user_id = $1 AND read = false",
        [userId],
      );
      res.json({ unread: unread.rows[0]?.unread ?? 0 });
    } catch (error) {
      console.error("Error marking notifications read:", error);
      res.status(500).json({ error: "Failed to mark read" });
    }
  },
);

export default router;

