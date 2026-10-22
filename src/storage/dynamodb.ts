import {
  CreateTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ResourceInUseException,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoDBOptions {
  region: string;
  endpoint?: string | undefined;
}

export const TTL_ATTRIBUTE = "ttl";

export function createDynamoDBClient({ region, endpoint }: DynamoDBOptions): DynamoDBClient {
  return new DynamoDBClient(endpoint ? { region, endpoint } : { region });
}

export function createDocumentClient(options: DynamoDBOptions): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(createDynamoDBClient(options), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

// Creates the single table (PK/SK, on-demand, TTL on "ttl") if it does not exist yet.
export async function ensureTable(client: DynamoDBClient, tableName: string): Promise<"created" | "exists"> {
  let outcome: "created" | "exists" = "created";
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
      }),
    );
  } catch (error) {
    if (!(error instanceof ResourceInUseException)) throw error;
    outcome = "exists";
  }

  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: tableName });
  await enableTtl(client, tableName);
  return outcome;
}

async function enableTtl(client: DynamoDBClient, tableName: string): Promise<void> {
  const { TimeToLiveDescription } = await client.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
  const status = TimeToLiveDescription?.TimeToLiveStatus;
  if (status === "ENABLED" || status === "ENABLING") return;
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: TTL_ATTRIBUTE, Enabled: true },
    }),
  );
}

export type Item = Record<string, unknown>;

export function stringAttribute(item: Item, name: string): string {
  const value = item[name];
  if (typeof value !== "string") {
    throw new Error(`Attribute "${name}" is missing or not a string`);
  }
  return value;
}

export function numberAttribute(item: Item, name: string): number {
  const value = item[name];
  if (typeof value !== "number") {
    throw new Error(`Attribute "${name}" is missing or not a number`);
  }
  return value;
}
