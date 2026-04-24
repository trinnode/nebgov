import request from "supertest";
import app from "../index";

describe("Health Endpoint", () => {
  it("returns status payload with ISO timestamp", async () => {
    const response = await request(app).get("/health").expect(200);

    expect(response.body).toHaveProperty("status", "ok");
    expect(response.body).toHaveProperty("timestamp");
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });

  it("is exempt from global rate limiting", async () => {
    for (let i = 0; i < 120; i++) {
      const response = await request(app).get("/health");
      expect(response.status).toBe(200);
    }
  });
});
