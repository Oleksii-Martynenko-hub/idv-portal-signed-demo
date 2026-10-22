import { fileTypeFromBuffer } from "file-type";

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

const EXTENSIONS: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// Looks at the bytes only; the type the client declares is not trusted.
export async function detectImageType(bytes: Uint8Array): Promise<ImageType | undefined> {
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected || !isAllowedImageType(detected.mime)) return undefined;
  return detected.mime;
}

export function extensionFor(type: ImageType): string {
  return EXTENSIONS[type];
}

function isAllowedImageType(mime: string): mime is ImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(mime);
}
