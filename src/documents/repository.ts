import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Item, numberAttribute, stringAttribute } from "../storage/dynamodb.js";

export const DOCUMENT_KINDS = ["passport", "id_card", "driving_licence"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface DocumentRecord {
  id: string;
  userId: string;
  kind: DocumentKind;
  fileName: string;
  contentType: string;
  size: number;
  s3Key: string;
  status: "received";
  createdAt: string;
}

const ownerPartition = (userId: string) => `USER#${userId}`;
const documentSortKey = (documentId: string) => `DOC#${documentId}`;

export class DocumentRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async put(document: DocumentRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          PK: ownerPartition(document.userId),
          SK: documentSortKey(document.id),
          documentId: document.id,
          userId: document.userId,
          kind: document.kind,
          fileName: document.fileName,
          contentType: document.contentType,
          size: document.size,
          s3Key: document.s3Key,
          status: document.status,
          createdAt: document.createdAt,
        },
      }),
    );
  }

  async findByOwner(userId: string, documentId: string): Promise<DocumentRecord | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: ownerPartition(userId), SK: documentSortKey(documentId) },
      }),
    );
    return Item ? recordFromItem(Item) : undefined;
  }

  async listByOwner(userId: string): Promise<DocumentRecord[]> {
    const documents: DocumentRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": ownerPartition(userId), ":prefix": documentSortKey("") },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        documents.push(recordFromItem(item));
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async delete(userId: string, documentId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { PK: ownerPartition(userId), SK: documentSortKey(documentId) },
      }),
    );
  }
}

function recordFromItem(item: Item): DocumentRecord {
  const kind = stringAttribute(item, "kind");
  if (!isDocumentKind(kind)) {
    throw new Error(`Unknown document kind "${kind}"`);
  }
  return {
    id: stringAttribute(item, "documentId"),
    userId: stringAttribute(item, "userId"),
    kind,
    fileName: stringAttribute(item, "fileName"),
    contentType: stringAttribute(item, "contentType"),
    size: numberAttribute(item, "size"),
    s3Key: stringAttribute(item, "s3Key"),
    status: "received",
    createdAt: stringAttribute(item, "createdAt"),
  };
}

function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}
