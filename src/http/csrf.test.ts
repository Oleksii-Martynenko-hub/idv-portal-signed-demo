import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import { csrfProtection } from "./csrf.js";
import { errorHandler } from "./errors.js";

function createApp() {
  const app = express();
  app.use(csrfProtection);
  app.get("/item", (_req, res) => res.sendStatus(204));
  app.post("/item", (_req, res) => res.sendStatus(204));
  app.delete("/item", (_req, res) => res.sendStatus(204));
  app.use(errorHandler);
  return app;
}

describe("csrfProtection", () => {
  it("lets safe methods through without headers", async () => {
    await request(createApp()).get("/item").expect(204);
  });

  it("accepts same-origin and user-initiated requests", async () => {
    const app = createApp();
    await request(app).post("/item").set("Sec-Fetch-Site", "same-origin").expect(204);
    await request(app).delete("/item").set("Sec-Fetch-Site", "none").expect(204);
  });

  it("rejects cross-site and same-site requests", async () => {
    const app = createApp();
    const response = await request(app).post("/item").set("Sec-Fetch-Site", "cross-site").expect(403);
    assert.deepEqual(response.body, {
      error: { code: "cross_site_request", message: "Cross-site requests are not allowed." },
    });
    await request(app).delete("/item").set("Sec-Fetch-Site", "same-site").expect(403);
  });

  it("falls back to comparing Origin with the request host", async () => {
    const app = createApp();
    await request(app)
      .post("/item")
      .set("Host", "portal.example.com")
      .set("Origin", "https://portal.example.com")
      .expect(204);
    await request(app)
      .post("/item")
      .set("Host", "localhost:8080")
      .set("Origin", "http://LOCALHOST:8080")
      .expect(204);
    await request(app)
      .post("/item")
      .set("Host", "portal.example.com")
      .set("Origin", "https://evil.example.com")
      .expect(403);
    await request(app).post("/item").set("Host", "portal.example.com").set("Origin", "null").expect(403);
  });

  it("rejects state changes that carry neither header", async () => {
    await request(createApp()).post("/item").expect(403);
  });
});
