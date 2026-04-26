import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import competitionsRouter from "./routes/competitions";
import leaderboardRouter from "./routes/leaderboard";
import authRouter from "./routes/auth";
import notificationsRouter from "./routes/notifications";
import pino from "pino";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many join attempts" },
});

const leaderboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Logging middleware
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
  }),
);

// Swagger documentation
app.get("/openapi.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(generateOpenApiDocument());
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));

// Health check — exempt from rate limiting
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Apply global limiter to all routes below
app.use(globalLimiter);

// Routes
app.use("/auth", authRouter);
app.use("/competitions", competitionsRouter);
app.post("/competitions/:id/join", joinLimiter);
app.post("/competitions/:id/leave", joinLimiter);
app.use("/leaderboard/history", leaderboardLimiter);
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
