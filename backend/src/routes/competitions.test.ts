import request from "supertest";
import express, { Express } from "express";

// Use a simple mock that we can control
const mockQuery = jest.fn();
jest.mock("../db/pool", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  connect: jest.fn(),
}));

import competitionsRouter from "./competitions";

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/competitions", competitionsRouter);
  return app;
}

describe("Competitions API", () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe("GET /competitions", () => {
    it("returns paginated list of competitions", async () => {
      const mockCompetitions = [
        {
          id: 1,
          name: "Test Competition",
          description: "A test competition",
          entry_fee: "100",
          start_date: new Date("2025-01-01"),
          end_date: new Date("2025-12-31"),
          is_active: true,
          created_by: 1,
          created_at: new Date(),
          updated_at: new Date(),
          participant_count: "5",
        },
      ];

      mockQuery
        .mockResolvedValueOnce({
          rows: mockCompetitions,
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "1" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const response = await request(app)
        .get("/competitions")
        .expect(200);

      expect(response.body).toHaveProperty("competitions");
      expect(response.body).toHaveProperty("total");
      expect(response.body).toHaveProperty("limit");
      expect(response.body).toHaveProperty("offset");
      expect(response.body.competitions).toHaveLength(1);
      expect(response.body.competitions[0].name).toBe("Test Competition");
      expect(response.body.total).toBe(1);
    });

    it("returns empty array when no competitions exist", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const response = await request(app)
        .get("/competitions")
        .expect(200);

      expect(response.body.competitions).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it("filters by is_active query param", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      await request(app)
        .get("/competitions?is_active=true")
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("is_active"),
        expect.any(Array),
      );
    });

    it("respects limit and offset query params", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      await request(app)
        .get("/competitions?limit=10&offset=5")
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT"),
        expect.arrayContaining([10, 5]),
      );
    });

    it("uses default limit and offset when not provided", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      await request(app).get("/competitions").expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT $"),
        expect.arrayContaining([20, 0]),
      );
    });

    it("returns 400 for invalid limit", async () => {
      const response = await request(app)
        .get("/competitions?limit=invalid")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
      expect(response.body.errors[0].field).toBe("limit");
    });

    it("returns 400 for negative offset", async () => {
      const response = await request(app)
        .get("/competitions?offset=-1")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
      expect(response.body.errors[0].field).toBe("offset");
    });

    it("returns 400 for limit exceeding max", async () => {
      const response = await request(app)
        .get("/competitions?limit=999")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
    });
  });

  describe("GET /competitions/:id", () => {
    it("returns a single competition with participant count", async () => {
      const mockCompetition = {
        id: 1,
        name: "Test Competition",
        description: "A test competition",
        entry_fee: "100",
        start_date: new Date("2025-01-01"),
        end_date: new Date("2025-12-31"),
        is_active: true,
        created_by: 1,
        created_at: new Date(),
        updated_at: new Date(),
        participant_count: "42",
      };

      mockQuery.mockResolvedValueOnce({
        rows: [mockCompetition],
        command: "",
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/competitions/1")
        .expect(200);

      expect(response.body).toHaveProperty("competition");
      expect(response.body.competition.name).toBe("Test Competition");
      expect(response.body.competition.participant_count).toBe("42");
    });

    it("returns 404 for non-existent competition", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: "",
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/competitions/999")
        .expect(404);

      expect(response.body).toHaveProperty("error");
      expect(response.body.error).toBe("Competition not found");
    });

    it("returns 400 for invalid id format", async () => {
      const response = await request(app)
        .get("/competitions/invalid")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
      expect(response.body.errors[0].field).toBe("id");
    });
  });

  describe("GET /competitions/:id/participants", () => {
    it("returns paginated participant list", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 1 }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 1,
              competition_id: 1,
              user_id: 1,
              joined_at: new Date(),
              entry_fee_paid: "100",
              wallet_address: "0x123",
            },
          ],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "1" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const response = await request(app)
        .get("/competitions/1/participants")
        .expect(200);

      expect(response.body).toHaveProperty("participants");
      expect(response.body).toHaveProperty("total");
      expect(response.body.participants).toHaveLength(1);
      expect(response.body.participants[0]).toHaveProperty("wallet_address");
    });

    it("returns empty array when no participants", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 1 }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const response = await request(app)
        .get("/competitions/1/participants")
        .expect(200);

      expect(response.body.participants).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it("respects limit and offset params", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 1 }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [],
          command: "",
          rowCount: 0,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ count: "0" }],
          command: "",
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      await request(app)
        .get("/competitions/1/participants?limit=5&offset=10")
        .expect(200);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("LIMIT"),
        expect.arrayContaining([5, 10]),
      );
    });

    it("returns 404 when competition does not exist", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [],
        command: "",
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const response = await request(app)
        .get("/competitions/999/participants")
        .expect(404);

      expect(response.body).toHaveProperty("error");
    });

    it("returns 400 for invalid competition id", async () => {
      const response = await request(app)
        .get("/competitions/invalid/participants")
        .expect(400);

      expect(response.body).toHaveProperty("errors");
    });
  });
});