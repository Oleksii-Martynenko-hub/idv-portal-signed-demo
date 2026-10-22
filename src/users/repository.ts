import { randomUUID } from "node:crypto";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { stringAttribute, type Item } from "../storage/dynamodb.js";

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

const userKey = (id: string) => ({ PK: `USER#${id}`, SK: "PROFILE" });
const emailKey = (email: string) => ({ PK: `EMAIL#${email}`, SK: "USER" });

export class UserRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async findById(id: string): Promise<User | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: userKey(id) }));
    return Item ? toUser(Item) : undefined;
  }

  // Expects a normalized email.
  async findByEmail(email: string): Promise<User | undefined> {
    const { Item } = await this.client.send(new GetCommand({ TableName: this.tableName, Key: emailKey(email) }));
    return Item ? this.findById(stringAttribute(Item, "userId")) : undefined;
  }

  // The email index and the profile are written in one transaction so an email
  // can never point at two users, even when sign-ins race.
  async create(email: string): Promise<User> {
    const user: User = { id: randomUUID(), email, createdAt: new Date().toISOString() };
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: { ...emailKey(email), userId: user.id },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: { ...userKey(user.id), userId: user.id, email: user.email, createdAt: user.createdAt },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
    return user;
  }

  async findOrCreate(email: string): Promise<User> {
    const existing = await this.findByEmail(email);
    if (existing) return existing;
    try {
      return await this.create(email);
    } catch (error) {
      if (!(error instanceof TransactionCanceledException)) throw error;
      // Another request registered this email first.
      const user = await this.findByEmail(email);
      if (!user) throw error;
      return user;
    }
  }
}

function toUser(item: Item): User {
  return {
    id: stringAttribute(item, "userId"),
    email: stringAttribute(item, "email"),
    createdAt: stringAttribute(item, "createdAt"),
  };
}
