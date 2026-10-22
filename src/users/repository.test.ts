import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { FakeTable } from "../test-support.js";
import { UserRepository } from "./repository.js";

function setup() {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "eu-west-1" }));
  const mock = mockClient(client);
  const table = new FakeTable();
  table.attach(mock);
  return { users: new UserRepository(client, "idv-portal"), mock, table };
}

describe("UserRepository.findOrCreate", () => {
  it("creates the profile and the email index together, then reuses them", async () => {
    const { users, mock, table } = setup();

    const created = await users.findOrCreate("maria@example.com");
    const again = await users.findOrCreate("maria@example.com");

    assert.equal(again.id, created.id);
    assert.equal(mock.commandCalls(TransactWriteCommand).length, 1);
    assert.equal(table.find("EMAIL#maria@example.com", "USER")?.userId, created.id);
    assert.deepEqual(table.find(`USER#${created.id}`, "PROFILE"), {
      PK: `USER#${created.id}`,
      SK: "PROFILE",
      userId: created.id,
      email: "maria@example.com",
      createdAt: created.createdAt,
    });
  });

  it("falls back to the winner when two sign-ins race for the same email", async () => {
    const { users, mock, table } = setup();
    const winner = { PK: "USER#winner", SK: "PROFILE", userId: "winner", email: "maria@example.com", createdAt: "2026-01-01T00:00:00.000Z" };
    mock.on(TransactWriteCommand).callsFake(() => {
      table.insert({ PK: "EMAIL#maria@example.com", SK: "USER", userId: "winner" });
      table.insert(winner);
      throw new TransactionCanceledException({ $metadata: {}, message: "Transaction cancelled" });
    });

    const user = await users.findOrCreate("maria@example.com");

    assert.equal(user.id, "winner");
  });

  it("propagates other failures", async () => {
    const { users, mock } = setup();
    mock.on(TransactWriteCommand).rejects(new Error("network down"));

    await assert.rejects(users.findOrCreate("maria@example.com"), /network down/);
  });
});
