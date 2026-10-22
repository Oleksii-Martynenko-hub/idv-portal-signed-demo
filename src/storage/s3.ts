import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface S3Options {
  region: string;
  endpoint?: string | undefined;
}

export function createS3Client({ region, endpoint }: S3Options): S3Client {
  return new S3Client(endpoint ? { region, endpoint, forcePathStyle: true } : { region });
}

export interface StoredObject {
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
}

export class ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        IfNoneMatch: "*",
      }),
    );
  }

  async get(key: string): Promise<StoredObject | undefined> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNoSuchKey(error)) return undefined;
      throw error;
    }
    if (!output.Body) return undefined;
    return {
      body: toReadable(output.Body),
      contentType: output.ContentType,
      contentLength: output.ContentLength,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function isNoSuchKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NoSuchKey";
}

function toReadable(body: NonNullable<GetObjectCommandOutput["Body"]>): Readable {
  if (body instanceof Readable) return body;
  if (body instanceof Blob) return Readable.fromWeb(body.stream() as unknown as WebReadableStream);
  return Readable.fromWeb(body as unknown as WebReadableStream);
}
