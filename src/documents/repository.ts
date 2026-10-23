import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Item, numberAttribute, stringAttribute } from "../storage/dynamodb.js";

export const DOCUMENT_KINDS = ["passport", "id_card", "driving_licence"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

interface DocumentFields {
  id: string;
  userId: string;
  kind: DocumentKind;
  fileName: string;
  contentType: string;
  size: number;
  createdAt: string;
}

// contentType is the type detected from the bytes.
export interface ReceivedDocument extends DocumentFields {
  status: "received";
  s3Key: string;
}

// Kept so the customer sees why an upload failed; contentType is the declared type.
export interface RejectedDocument extends DocumentFields {
  status: "rejected";
  rejectionCode: string;
  rejectionReason: string;
}

export type DocumentRecord = ReceivedDocument | RejectedDocument;

export const ownerPartition = (userId: string) => `USER#${userId}`;
const documentSortKey = (documentId: string) => `DOC#${documentId}`;

export function documentItem(document: DocumentRecord): Item {
  const common = {
    PK: ownerPartition(document.userId),
    SK: documentSortKey(document.id),
    documentId: document.id,
    userId: document.userId,
    kind: document.kind,
    fileName: document.fileName,
    contentType: document.contentType,
    size: document.size,
    status: document.status,
    createdAt: document.createdAt,
  };
  if (document.status === "received") {
    return { ...common, s3Key: document.s3Key };
  }
  return { ...common, rejectionCode: document.rejectionCode, rejectionReason: document.rejectionReason };
}

export class DocumentRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  // Reads are strongly consistent: the page lists documents right after a completion wrote one.
  async findByOwner(userId: string, documentId: string): Promise<DocumentRecord | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { PK: ownerPartition(userId), SK: documentSortKey(documentId) },
        ConsistentRead: true,
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
          ConsistentRead: true,
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
  const fields: DocumentFields = {
    id: stringAttribute(item, "documentId"),
    userId: stringAttribute(item, "userId"),
    kind,
    fileName: stringAttribute(item, "fileName"),
    contentType: stringAttribute(item, "contentType"),
    size: numberAttribute(item, "size"),
    createdAt: stringAttribute(item, "createdAt"),
  };
  const status = stringAttribute(item, "status");
  if (status === "received") {
    return { ...fields, status, s3Key: stringAttribute(item, "s3Key") };
  }
  if (status === "rejected") {
    return {
      ...fields,
      status,
      rejectionCode: stringAttribute(item, "rejectionCode"),
      rejectionReason: stringAttribute(item, "rejectionReason"),
    };
  }
  throw new Error(`Unknown document status "${status}"`);
}

export function isDocumentKind(value: unknown): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly unknown[]).includes(value);
}
