import { Router, Response } from "express";
import { param, validationResult } from "express-validator";
import { z } from "zod";
import pool from "../db/pool";
import { authenticate, AuthRequest } from "../middleware/auth";
import { Competition } from "../entities/Competition";
import { CompetitionParticipant } from "../entities/CompetitionParticipant";

const router = Router();

// Zod schemas for validation
const listCompetitionsSchema = z.object({
  is_active: z.enum(["true", "false"]).transform(v => v === "true").optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const getCompetitionSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const listParticipantsSchema = z.object({
  id: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// GET /competitions - List all competitions with pagination
router.get(
  "/",
  async (req, res) => {
    const parsed = listCompetitionsSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        errors: parsed.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }

    const { is_active, limit, offset } = parsed.data;

    try {
      let queryText = `
        SELECT
          c.*,
          COUNT(cp.id) AS participant_count
        FROM competitions c
        LEFT JOIN competition_participants cp ON c.id = cp.competition_id
        WHERE 1=1
      `;
      const queryParams: unknown[] = [];
      let paramIndex = 1;

      if (is_active !== undefined) {
        queryText += ` AND c.is_active = $${paramIndex}`;
        queryParams.push(is_active);
        paramIndex++;
      }

      queryText += ` GROUP BY c.id ORDER BY c.start_date DESC`;
      queryText += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      queryParams.push(limit, offset);

      const result = await pool.query(queryText, queryParams);

      let countQuery = "SELECT COUNT(*) FROM competitions WHERE 1=1";
      const countParams: unknown[] = [];

      if (is_active !== undefined) {
        countQuery += " AND is_active = $1";
        countParams.push(is_active);
      }

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      res.json({
        competitions: result.rows,
        total,
        limit,
        offset,
      });
    } catch (error) {
      console.error("Error fetching competitions:", error);
      res.status(500).json({ error: "Failed to fetch competitions" });
    }
  },
);

// GET /competitions/:id - Get single competition
router.get(
  "/:id",
  async (req: AuthRequest, res: Response) => {
    const parsed = getCompetitionSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({
        errors: parsed.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }

    try {
      const competitionId = parsed.data.id;

      const result = await pool.query(
        `SELECT c.*, COUNT(cp.id) AS participant_count
         FROM competitions c
         LEFT JOIN competition_participants cp ON c.id = cp.competition_id
         WHERE c.id = $1
         GROUP BY c.id`,
        [competitionId],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = result.rows[0];
      const response: Record<string, unknown> = { competition };

      if (req.userId) {
        const participantResult = await pool.query(
          "SELECT id FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
          [competitionId, req.userId],
        );
        response.is_joined = participantResult.rows.length > 0;
      }

      res.json(response);
    } catch (error) {
      console.error("Error fetching competition:", error);
      res.status(500).json({ error: "Failed to fetch competition" });
    }
  },
);

// GET /competitions/:id/participants - Get competition participants
router.get(
  "/:id/participants",
  async (req, res) => {
    const parsed = listParticipantsSchema.safeParse({
      id: req.params.id,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    if (!parsed.success) {
      return res.status(400).json({
        errors: parsed.error.issues.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        })),
      });
    }

    const { id: competitionId, limit, offset } = parsed.data;

    try {
      const compResult = await pool.query(
        "SELECT id FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        return res.status(404).json({ error: "Competition not found" });
      }

      const queryText = `
        SELECT
          cp.*,
          u.wallet_address
        FROM competition_participants cp
        JOIN users u ON cp.user_id = u.id
        WHERE cp.competition_id = $1
        ORDER BY cp.joined_at DESC
        LIMIT $2 OFFSET $3
      `;

      const result = await pool.query(queryText, [competitionId, limit, offset]);

      const countResult = await pool.query(
        "SELECT COUNT(*) FROM competition_participants WHERE competition_id = $1",
        [competitionId],
      );
      const total = parseInt(countResult.rows[0].count);

      res.json({
        participants: result.rows,
        total,
        limit,
        offset,
      });
    } catch (error) {
      console.error("Error fetching participants:", error);
      res.status(500).json({ error: "Failed to fetch participants" });
    }
  },
);

// POST /competitions/:id/join - Join a competition
router.post(
  "/:id/join",
  authenticate,
  param("id").isInt().toInt(),
  async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const competitionId = parseInt(req.params.id);
      const userId = req.userId!;

      const compResult = await client.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = compResult.rows[0];

      if (!competition.is_active) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "Competition is not active" });
      }

      if (new Date() >= new Date(competition.start_date)) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Competition has already started" });
      }

      const existingResult = await client.query(
        "SELECT * FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );

      if (existingResult.rows.length > 0) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Already joined this competition" });
      }

      const insertResult = await client.query<CompetitionParticipant>(
        `INSERT INTO competition_participants (competition_id, user_id, entry_fee_paid)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [competitionId, userId, competition.entry_fee],
      );

      await client.query("COMMIT");

      res.status(201).json({
        message: "Successfully joined competition",
        participant: insertResult.rows[0],
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error joining competition:", error);
      res.status(500).json({ error: "Failed to join competition" });
    } finally {
      client.release();
    }
  },
);

// DELETE /competitions/:id/leave - Leave a competition
router.delete(
  "/:id/leave",
  authenticate,
  param("id").isInt().toInt(),
  async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const competitionId = parseInt(req.params.id);
      const userId = req.userId!;

      const compResult = await client.query<Competition>(
        "SELECT * FROM competitions WHERE id = $1",
        [competitionId],
      );

      if (compResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Competition not found" });
      }

      const competition = compResult.rows[0];

      if (new Date() >= new Date(competition.start_date)) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "Cannot leave competition after it has started",
        });
      }

      const participantResult = await client.query<CompetitionParticipant>(
        "SELECT * FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );

      if (participantResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res
          .status(404)
          .json({ error: "Not a participant in this competition" });
      }

      const participant = participantResult.rows[0];

      await client.query(
        "DELETE FROM competition_participants WHERE competition_id = $1 AND user_id = $2",
        [competitionId, userId],
      );

      await client.query("COMMIT");

      res.json({
        message: "Successfully left competition",
        refund: participant.entry_fee_paid.toString(),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      console.error("Error leaving competition:", error);
      res.status(500).json({ error: "Failed to leave competition" });
    } finally {
      client.release();
    }
  },
);

export default router;