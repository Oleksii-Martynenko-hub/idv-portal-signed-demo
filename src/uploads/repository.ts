import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DeleteCommandInput,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { type ImageType, isImageType } from "../documents/file-type.js";
import {
  type DocumentKind,
  type DocumentRecord,
  documentItem,
  isDocumentKind,
  ownerPartition,
} from "../documents/repository.js";
import { type Item, numberAttribute, stringAttribute, TTL_ATTRIBUTE } from "../storage/dynamodb.js";

export type UploadStatus = "pending" | "verifying";

// An upload URL that has been handed out and not completed yet.
export interface PendingUpload {
  id: string;
  userId: string;
  kind: DocumentKind;
  fileName: string;
  contentType: ImageType;
  size: number;
  stagingKey: string;
  checksumSha256: string;
  status: UploadStatus;
  createdAt: string;
  expiresAt: string;
}

// The table's TTL removes records nobody completed, a day after the URL expired.
const RETENTION_SECONDS = 24 * 60 * 60;

const uploadSortKey = (documentId: string) => `UPLOAD#${documentId}`;
const uploadKey = (userId: string, documentId: string) => ({
  PK: ownerPartition(userId),
  SK: uploadSortKey(documentId),
});

export class PendingUploadRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(upload: PendingUpload): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...uploadKey(upload.userId, upload.id),
          documentId: upload.id,
          userId: upload.userId,
          kind: upload.kind,
          fileName: upload.fileName,
          contentType: upload.contentType,
          size: upload.size,
          stagingKey: upload.stagingKey,
          checksumSha256: upload.checksumSha256,
          status: upload.status,
          createdAt: upload.createdAt,
          expiresAt: upload.expiresAt,
          [TTL_ATTRIBUTE]: Math.floor(Date.parse(upload.expiresAt) / 1000) + RETENTION_SECONDS,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  // Reads are strongly consistent: the page completes or cancels an upload moments after creating it.
  async findByOwner(userId: string, documentId: string): Promise<PendingUpload | undefined> {
    const { Item } = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: uploadKey(userId, documentId), ConsistentRead: true }),
    );
    return Item ? uploadFromItem(Item) : undefined;
  }

  async listByOwner(userId: string): Promise<PendingUpload[]> {
    const uploads: PendingUpload[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": ownerPartition(userId), ":prefix": uploadSortKey("") },
          ExclusiveStartKey: startKey,
          ConsistentRead: true,
        }),
      );
      for (const item of page.Items ?? []) {
        uploads.push(uploadFromItem(item));
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return uploads;
  }

  // Only one completion request may check and promote an upload. False when another one holds it.
  async claim(userId: string, documentId: string): Promise<boolean> {
    return this.moveStatus(userId, documentId, "pending", "verifying");
  }

  // Lets the customer try the completion again; a no-op when the record has gone.
  async release(userId: string, documentId: string): Promise<void> {
    await this.moveStatus(userId, documentId, "verifying", "pending");
  }

  // True when this call removed the record; false when it had gone already,
  // for example because a completion finished first.
  async delete(userId: string, documentId: string): Promise<boolean> {
    return this.deleteWhere(userId, documentId, { ConditionExpression: "attribute_exists(PK)" });
  }

  // Gives up an upload nobody is completing. False when it has gone or a completion holds it.
  async deletePending(userId: string, documentId: string): Promise<boolean> {
    return this.deleteWhere(userId, documentId, {
      ConditionExpression: "attribute_exists(PK) AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "pending" },
    });
  }

  // Replaces the claimed upload with its document in one step, so a document
  // never exists next to the upload it came from.
  async finish(upload: PendingUpload, document: DocumentRecord): Promise<void> {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: uploadKey(upload.userId, upload.id),
              ConditionExpression: "#status = :verifying",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":verifying": "verifying" },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: documentItem(document),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
  }

  private async deleteWhere(
    userId: string,
    documentId: string,
    condition: Omit<DeleteCommandInput, "TableName" | "Key">,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new DeleteCommand({ TableName: this.tableName, Key: uploadKey(userId, documentId), ...condition }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  private async moveStatus(userId: string, documentId: string, from: UploadStatus, to: UploadStatus): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: uploadKey(userId, documentId),
          UpdateExpression: "SET #status = :to",
          ConditionExpression: "#status = :from",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":from": from, ":to": to },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}

function uploadFromItem(item: Item): PendingUpload {
  const kind = stringAttribute(item, "kind");
  const contentType = stringAttribute(item, "contentType");
  const status = stringAttribute(item, "status");
  if (!isDocumentKind(kind) || !isImageType(contentType) || (status !== "pending" && status !== "verifying")) {
    throw new Error(`Malformed upload record "${String(item.SK)}"`);
  }
  return {
    id: stringAttribute(item, "documentId"),
    userId: stringAttribute(item, "userId"),
    kind,
    fileName: stringAttribute(item, "fileName"),
    contentType,
    size: numberAttribute(item, "size"),
    stagingKey: stringAttribute(item, "stagingKey"),
    checksumSha256: stringAttribute(item, "checksumSha256"),
    status,
    createdAt: stringAttribute(item, "createdAt"),
    expiresAt: stringAttribute(item, "expiresAt"),
  };
}
