import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import { createHttpLogger, createLogger } from "../logger.js";
import { errorHandler, HttpError, notFoundHandler } from "./errors.js";

function createApp() {
  const app = express();
  app.use(createHttpLogger(createLogger("silent")));
  app.get("/http-error", () => {
    throw new HttpError(418, "teapot", "Short and stout.");
  });
  app.get("/async-failure", async () => {
    throw new Error("secret details about bucket-name and table-name");
  });
  app.post("/json", express.json({ limit: "1kb" }), (_req, res) => res.sendStatus(204));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("renders HttpError with its status and code", async () => {
    const response = await request(createApp()).get("/http-error").expect(418);
    assert.deepEqual(response.body, { error: { code: "teapot", message: "Short and stout." } });
  });

  it("hides details of unexpected failures", async () => {
    const response = await request(createApp()).get("/async-failure").expect(500);
    assert.deepEqual(response.body, {
      error: { code: "internal_error", message: "Something went wrong. Try again later." },
    });
    assert.doesNotMatch(response.text, /secret details|bucket-name|table-name|at /);
  });

  it("maps body parser failures to client errors", async () => {
    const app = createApp();
    const invalid = await request(app).post("/json").set("Content-Type", "application/json").send("{not json").expect(400);
    assert.equal(invalid.body.error.code, "invalid_json");
    const large = await request(app).post("/json").send({ padding: "x".repeat(2048) }).expect(413);
    assert.equal(large.body.error.code, "payload_too_large");
  });

  it("answers unknown routes with JSON", async () => {
    const response = await request(createApp()).get("/missing").expect(404);
    assert.deepEqual(response.body, { error: { code: "not_found", message: "Not found." } });
  });
});
