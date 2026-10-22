import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { stringAttribute, TTL_ATTRIBUTE } from "../storage/dynamodb.js";

export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewSession {
  tokenHash: string;
  userId: string;
  ttlSeconds: number;
}

const sessionKey = (tokenHash: string) => ({ PK: `SESSION#${tokenHash}`, SK: "SESSION" });

export class SessionRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create({ tokenHash, userId, ttlSeconds }: NewSession): Promise<Session> {
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...sessionKey(tokenHash),
          userId,
          createdAt: createdAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          [TTL_ATTRIBUTE]: Math.floor(expiresAt.getTime() / 1000),
        },
      }),
    );
    return { tokenHash, userId, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() };
  }

  async findByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: sessionKey(tokenHash) }),
    );
    if (!Item) return undefined;
    return {
      tokenHash,
      userId: stringAttribute(Item, "userId"),
      createdAt: stringAttribute(Item, "createdAt"),
      expiresAt: stringAttribute(Item, "expiresAt"),
    };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.tableName, Key: sessionKey(tokenHash) }));
  }
}
