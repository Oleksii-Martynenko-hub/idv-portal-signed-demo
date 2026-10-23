import type { ObjectHead } from "../storage/s3.js";

// What the PUT is signed with; the staged object must carry exactly these.
export const STAGING_CACHE_CONTROL = "private, no-store";
export const STAGING_CONTENT_DISPOSITION = "attachment";

export const REJECTIONS = {
  size_mismatch: "The uploaded file does not match the declared size.",
  type_mismatch: "The uploaded file does not match the declared type.",
  unexpected_metadata: "The upload carried headers that are not allowed.",
  checksum_mismatch: "The uploaded file does not match the declared checksum.",
  unsupported_file_type: "The file is not a JPEG, PNG or WebP image.",
  object_changed: "The file changed while it was being checked. Upload it again.",
} as const;

export type RejectionCode = keyof typeof REJECTIONS;

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface DeclaredUpload {
  size: number;
  contentType: string;
  checksumSha256: string;
}

export function rejection(code: RejectionCode): Rejection {
  return { code, message: REJECTIONS[code] };
}

// The signature binds most of this already; the checks catch whatever S3
// stored anyway, such as unsigned standard headers sent alongside the PUT.
export function inspectStagedObject(declared: DeclaredUpload, head: ObjectHead): Rejection | undefined {
  if (head.size !== declared.size) return rejection("size_mismatch");
  if (head.contentType !== declared.contentType) return rejection("type_mismatch");
  if (
    head.cacheControl !== STAGING_CACHE_CONTROL ||
    head.contentDisposition !== STAGING_CONTENT_DISPOSITION ||
    head.contentEncoding !== undefined ||
    head.contentLanguage !== undefined ||
    head.expires !== undefined ||
    head.websiteRedirectLocation !== undefined ||
    Object.keys(head.metadata).length > 0
  ) {
    return rejection("unexpected_metadata");
  }
  if (head.checksumSha256 !== declared.checksumSha256) return rejection("checksum_mismatch");
  return undefined;
}
