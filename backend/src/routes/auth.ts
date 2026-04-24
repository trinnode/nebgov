import { Router } from "express";
import { body, validationResult } from "express-validator";
import jwt from "jsonwebtoken";
import pool from "../db/pool";

const router = Router();

// POST /auth/login - Create/find user and return JWT (dev/simple auth)
router.post(
  "/login",
  body("wallet_address").isString().trim().isLength({ min: 10, max: 56 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const walletAddress = (req.body.wallet_address as string).trim();

    try {
      const existing = await pool.query<{ id: number; wallet_address: string }>(
        "SELECT id, wallet_address FROM users WHERE wallet_address = $1",
        [walletAddress],
      );

      const userId =
        existing.rows[0]?.id ??
        (
          await pool.query<{ id: number }>(
            "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
            [walletAddress],
          )
        ).rows[0].id;

      const token = jwt.sign(
        { userId, walletAddress },
        process.env.JWT_SECRET!,
        { expiresIn: "30d" },
      );

      res.json({ token, user_id: userId, wallet_address: walletAddress });
    } catch (error) {
      console.error("Error in /auth/login:", error);
      res.status(500).json({ error: "Failed to login" });
    }
  },
);

export default router;

