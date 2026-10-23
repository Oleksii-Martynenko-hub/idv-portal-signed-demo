const MAX_FILE_NAME_LENGTH = 200;
// Half of a surrogate pair without the other half. JSON carries one, but it cannot be
// encoded as UTF-8, so it would break the Content-Disposition built from the name.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Keeps a display name for the uploaded file. It is never used to build a storage key.
export function sanitizeFileName(raw: string | undefined, extension: string): string {
  const wellFormed = (raw ?? "").replace(LONE_SURROGATE, "\ufffd");
  const base = wellFormed.split(/[\\/]/).pop() ?? "";
  const cleaned = Array.from(base.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .slice(0, MAX_FILE_NAME_LENGTH)
    .join("");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return `document.${extension}`;
  }
  return cleaned;
}

// RFC 6266 value with an ASCII fallback and a UTF-8 encoded form (RFC 8187).
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
