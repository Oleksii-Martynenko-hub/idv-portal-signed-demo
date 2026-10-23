// Object keys are built from the session's user id and a server-generated
// document id only; nothing the client sends ever becomes part of one.

// Where the browser's PUT lands. Lifecycle rules expire anything left here.
export function stagingKeyFor(userId: string, documentId: string): string {
  return `staging/users/${userId}/${documentId}`;
}

// Where a document lives once it has passed the checks. Only these are ever signed for reading.
export function fileKeyFor(userId: string, documentId: string): string {
  return `files/users/${userId}/${documentId}`;
}
