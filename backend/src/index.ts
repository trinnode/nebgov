import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import competitionsRouter from "./routes/competitions";
import leaderboardRouter from "./routes/leaderboard";
import authRouter from "./routes/auth";
import notificationsRouter from "./routes/notifications";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/auth", authRouter);
app.use("/competitions", competitionsRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/notifications", notificationsRouter);

// Error handling
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  },
);

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
  });
}

export default app;
