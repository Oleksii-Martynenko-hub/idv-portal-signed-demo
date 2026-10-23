import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AwsCredentials, SignerCredentials } from "./signer-credentials.js";

// Headroom between the URL's expiry and the credentials' expiry.
export const CLOCK_SKEW_SECONDS = 60;

const CHECKSUM_HEADER = "x-amz-checksum-sha256";

export interface UrlSignerOptions {
  bucket: string;
  region: string;
  endpoint: string | undefined;
  credentials: SignerCredentials;
}

export interface UploadUrlRequest {
  key: string;
  contentType: string;
  size: number;
  cacheControl: string;
  contentDisposition: string;
  checksumSha256?: string | undefined;
  expiresInSeconds: number;
}

export interface PresignedUpload {
  url: string;
  // Every header the PUT must carry, with these exact values. Content-Length is
  // signed as well but browsers set it from the body, which must be `size` bytes.
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadUrlRequest {
  key: string;
  contentType: string;
  contentDisposition: string;
  expiresInSeconds: number;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export class UrlSigner {
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string | undefined;
  private readonly credentials: SignerCredentials;
  private snapshot: { credentials: AwsCredentials; client: S3Client } | undefined;

  constructor({ bucket, region, endpoint, credentials }: UrlSignerOptions) {
    this.bucket = bucket;
    this.region = region;
    this.endpoint = endpoint;
    this.credentials = credentials;
  }

  async presignUpload(request: UploadUrlRequest): Promise<PresignedUpload> {
    const { key, contentType, size, cacheControl, contentDisposition, checksumSha256, expiresInSeconds } = request;
    const client = await this.clientFor(expiresInSeconds);
    const signedAt = wholeSecondsNow();
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: size,
        IfNoneMatch: "*",
        CacheControl: cacheControl,
        ContentDisposition: contentDisposition,
        ChecksumSHA256: checksumSha256,
      }),
      {
        signingDate: signedAt,
        expiresIn: expiresInSeconds,
        // The presigner never signs content-type and the signer never signs
        // cache-control unless listed here. Names must be lowercase.
        signableHeaders: new Set([
          "content-type",
          "content-length",
          "cache-control",
          "content-disposition",
          "if-none-match",
          CHECKSUM_HEADER,
        ]),
        // S3 checks the checksum only as a header; hoisted into the query it is ignored.
        unhoistableHeaders: new Set([CHECKSUM_HEADER]),
      },
    );
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": cacheControl,
      "Content-Disposition": contentDisposition,
      "If-None-Match": "*",
    };
    if (checksumSha256 !== undefined) {
      headers[CHECKSUM_HEADER] = checksumSha256;
    }
    return { url, headers, expiresAt: expiryOf(signedAt, expiresInSeconds) };
  }

  async presignDownload(request: DownloadUrlRequest): Promise<PresignedDownload> {
    const { key, contentType, contentDisposition, expiresInSeconds } = request;
    const client = await this.clientFor(expiresInSeconds);
    const signedAt = wholeSecondsNow();
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition,
        ResponseCacheControl: "private, no-store",
      }),
      { signingDate: signedAt, expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: expiryOf(signedAt, expiresInSeconds) };
  }

  // One client per credential snapshot: a client given a fixed credentials
  // object never swaps them, so the check in validFor holds for every URL it signs.
  private async clientFor(expiresInSeconds: number): Promise<S3Client> {
    const credentials = await this.credentials.validFor((expiresInSeconds + CLOCK_SKEW_SECONDS) * 1000);
    if (this.snapshot?.credentials !== credentials) {
      this.snapshot = { credentials, client: this.createClient(credentials) };
    }
    return this.snapshot.client;
  }

  private createClient(credentials: AwsCredentials): S3Client {
    return new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
      credentials,
      // Otherwise PUT URLs carry the CRC32 of an empty body and GET URLs ask
      // for checksum mode; the browser can satisfy neither.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
}

// X-Amz-Date has whole seconds, so signing at one keeps expiresAt exact.
function wholeSecondsNow(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function expiryOf(signedAt: Date, expiresInSeconds: number): Date {
  return new Date(signedAt.getTime() + expiresInSeconds * 1000);
}
