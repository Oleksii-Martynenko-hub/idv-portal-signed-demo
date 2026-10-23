import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface S3Options {
  region: string;
  endpoint?: string | undefined;
}

export function createS3Client({ region, endpoint }: S3Options): S3Client {
  // The ranged read of the first bytes cannot be checked against a whole-object checksum.
  const checksums = { responseChecksumValidation: "WHEN_REQUIRED" } as const;
  return new S3Client(endpoint ? { region, endpoint, forcePathStyle: true, ...checksums } : { region, ...checksums });
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
  eTag: string;
  cacheControl: string | undefined;
  contentDisposition: string | undefined;
  contentEncoding: string | undefined;
  contentLanguage: string | undefined;
  expires: string | undefined;
  websiteRedirectLocation: string | undefined;
  metadata: Record<string, string>;
  checksumSha256: string | undefined;
}

export interface Promotion {
  from: string;
  to: string;
  eTag: string;
  contentType: string;
  cacheControl: string;
  contentDisposition: string;
}

// The object no longer has the ETag a conditional read or copy asked for.
export class ObjectChangedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The object changed", options);
    this.name = "ObjectChangedError";
  }
}

export class ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  // Without s3:ListBucket S3 answers 403 rather than 404 for a missing key.
  async head(key: string): Promise<ObjectHead | undefined> {
    let output;
    try {
      output = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: "ENABLED" }),
      );
    } catch (error) {
      if (hasStatus(error, 404) || hasStatus(error, 403)) return undefined;
      throw error;
    }
    if (output.ETag === undefined || output.ContentLength === undefined) {
      throw new Error("HeadObject answered without ETag or Content-Length");
    }
    return {
      size: output.ContentLength,
      contentType: output.ContentType,
      eTag: output.ETag,
      cacheControl: output.CacheControl,
      contentDisposition: output.ContentDisposition,
      contentEncoding: output.ContentEncoding,
      contentLanguage: output.ContentLanguage,
      expires: output.ExpiresString ?? output.Expires?.toUTCString(),
      websiteRedirectLocation: output.WebsiteRedirectLocation,
      metadata: output.Metadata ?? {},
      checksumSha256: output.ChecksumSHA256,
    };
  }

  // The first `bytes` bytes of the object, provided it still has `eTag`.
  async readStart(key: string, bytes: number, eTag: string): Promise<Buffer> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}`, IfMatch: eTag }),
      );
      const body = output.Body ? await output.Body.transformToByteArray() : new Uint8Array();
      return Buffer.from(body).subarray(0, bytes);
    } catch (error) {
      if (isPreconditionFailed(error)) throw new ObjectChangedError({ cause: error });
      throw error;
    }
  }

  // Copies the exact version that was checked and replaces everything the
  // uploader could set with values chosen here. Returns the copy's SHA-256.
  async promote(promotion: Promotion): Promise<string | undefined> {
    const { from, to, eTag, contentType, cacheControl, contentDisposition } = promotion;
    try {
      const output = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: to,
          CopySource: `${this.bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
          CopySourceIfMatch: eTag,
          MetadataDirective: "REPLACE",
          ContentType: contentType,
          CacheControl: cacheControl,
          ContentDisposition: contentDisposition,
          ChecksumAlgorithm: "SHA256",
        }),
      );
      return output.CopyObjectResult?.ChecksumSHA256;
    } catch (error) {
      if (isPreconditionFailed(error)) throw new ObjectChangedError({ cause: error });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// HEAD answers carry no body, so the SDK names them "Unknown"; the status is what counts.
function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === status
  );
}

function isPreconditionFailed(error: unknown): boolean {
  return hasStatus(error, 412) || (error as { name?: unknown } | null)?.name === "PreconditionFailed";
}
