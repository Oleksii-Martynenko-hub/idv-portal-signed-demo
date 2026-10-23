# IDV Portal

Identity verification for customer accounts. A signed-in customer uploads a
photo of an ID document, sees the documents they have uploaded, opens any of
them and can delete one. Files travel between the browser and S3 directly,
through short-lived presigned URLs. The service authenticates the customer,
decides what they may do and signs the URL; once the file is in S3 it checks
it and promotes it. It never handles the file's bytes, apart from the first
few KB it reads back from S3 to recognise the format.

## Requirements

- Node.js 22 or newer and npm
- An S3 bucket and a DynamoDB table the service may use (`deploy/aws/` creates
  them), or a local stand-in for both (see
  [Without an AWS account](#without-an-aws-account))
- A CORS rule on the bucket for the origin the pages are served from
  (`deploy/aws/set-bucket-cors.sh` sets it)
- AWS credentials from the default provider chain: the instance role in
  production, a profile or environment variables locally

## How uploads work

1. The page sends the document type, file name, size, type and SHA-256 to
   `POST /api/uploads`. The service checks the session, the rate limit and
   the 20-document cap, generates a document id (a random UUID) and signs a
   PUT for `staging/users/<user id>/<document id>`, valid for five minutes.
   It records the upload as pending and answers with the URL and the headers
   the PUT must carry.
2. The browser PUTs the file to that URL. The service is not involved.
3. The page calls `POST /api/uploads/<id>/complete`. The service checks the
   staged object, copies it to `files/users/<user id>/<document id>` and
   records the document.

No part of a key comes from the client: the user id is the session's and the
document id is the server's. The file name is only a display name.

**What the PUT signature binds.** Besides the host and the key, the signature
covers `Content-Length` (the exact declared size), `Content-Type` (the
declared JPEG, PNG or WebP type), `Cache-Control: private, no-store`,
`Content-Disposition: attachment`, `If-None-Match: *` and
`x-amz-checksum-sha256`. A request that changes or drops any of them fails
with `403`. `If-None-Match: *` makes the URL create-only: it can never
replace a staged object that exists (such a PUT gets `412`), and the bucket
policy refuses any PUT into `staging/` without that header. S3 hashes the
body and answers `400 BadDigest` when it does not match the signed checksum,
so the URL accepts only the declared file. Once the service has accepted or
rejected the file it deletes the staged object, so until the URL expires the
same bytes could be PUT again; nothing completes that copy and the staging
lifecycle rule removes it. The checksum has to stay a request header; as a
query parameter it is signed but S3 does not check it. The SDK signs neither
`Content-Type` nor `Cache-Control` unless told to (`signableHeaders` in
`src/storage/presigner.ts`). `Cache-Control` is sent explicitly because a
browser adds `Cache-Control: no-cache` to a request that carries
`If-None-Match` unless the page sets its own, and that would not match the
signature.

**What completion checks.** One request at a time may complete an upload;
another one gets `409 upload_in_progress`. A `HEAD` of the staged object
(with checksum mode) must show the declared size and type, the signed
`Cache-Control` and `Content-Disposition`, no `Content-Encoding`,
`Content-Language`, `Expires`, website redirect or user metadata, and the
declared SHA-256. Standard headers such as `Content-Encoding` are not covered
by the signature, so S3 would store them if a client sent them. Then the
service reads the first 4100 bytes, pinned to the `ETag` the `HEAD` returned
(`If-Match`), and the format must be JPEG, PNG or WebP. Nothing in S3 yet
means `409 upload_not_received` and the upload stays open. The completion
deadline is the URL's expiry plus ten minutes, for a PUT that started just in
time; after it the answer is `410 upload_expired`.

**Promotion.** `CopyObject` copies the staged object only if it still has the
checked `ETag` (`x-amz-copy-source-if-match`) and replaces all metadata
(`MetadataDirective: REPLACE`): the type found in the bytes,
`Cache-Control: private, no-store` and an inline `Content-Disposition` with
the sanitised file name. The copy's SHA-256 is compared once more. One
DynamoDB transaction then replaces the pending upload with the document. If
DynamoDB cancels it, the service removes the promoted object before letting
another request complete the upload; if the outcome is unknown, such as a
lost response, the copy stays, and an upload that is in fact still open is
dealt with by a retry, a cancel or the expired-upload sweep. Last, the staged
object is deleted.

**Rejection.** A failed check answers `422` with the reason's code. The
document stays in the list as rejected, with the reason and no file: its
staged object is deleted. Rejected documents count towards the cap and can be
deleted like any other.

**Cleanup.** Deleting an object once the outcome is decided is best effort: a
failure is logged and the request goes on. A lifecycle rule expires
everything under `staging/` after a day and aborts incomplete multipart
uploads, which covers abandoned uploads, failed deletes there and repeated
PUTs. Nothing like it covers `files/`, so a promoted object that could not be
removed is logged as an error. A completion whose copy failed removes the
copy too, since it may have landed. Expired uploads are cleared the next time
the customer asks for an upload, or by a late completion (`410`): the record
goes first, on the condition that it is still there, then the staged object
and any promoted copy, so a completion that finished in the meantime keeps
its file. `DELETE /api/uploads/:id` gives up a pending upload straight away.
Pending upload records also carry a DynamoDB TTL a day after their URL
expired, for customers who do not come back; it removes only the record.

**Reading.** `GET /api/documents` signs a GET for each received document,
valid for 60 seconds. The URL forces the response's `Content-Type` (the
detected type), `Content-Disposition` and `Cache-Control: private, no-store`.
Only `files/users/<session user>/<document id>` is ever signed; the key is
rebuilt from the session, not read from the record. The account page fetches
fresh links before they expire.

**Two sets of credentials.** The instance role reads, copies and deletes
objects and uses the table; with a signer role configured, nothing is signed
with it. Presigned URLs are signed with a separate signer role
(`S3_SIGNER_ROLE_ARN`) that may only put objects under `staging/users/` and
get objects under `files/users/`; the service assumes it through STS with the
instance role, for an hour (the limit when one role assumes another). A URL
signed with temporary credentials stops working when they expire, whatever
its own expiry says, and the SDK neither refuses to sign nor refreshes for
that reason. So the service signs only with credentials that stay valid for
the URL's lifetime plus 60 seconds. Otherwise it assumes the role again, once
for all requests waiting, and signs with a new client for the new
credentials. Without `S3_SIGNER_ROLE_ARN` the default credentials sign, which
is how local development works; in production the service logs a warning at
startup, because the instance role cannot write to `staging/`. The policies
are in
[deploy/aws/README.md](deploy/aws/README.md#roles-and-what-they-may-do).

## Configuration

Environment variables, parsed once at startup in `src/config.ts`.
`.env.example` lists them with comments. The app never loads `.env` itself;
`npm run dev` passes `--env-file=.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `NODE_ENV` | `development` | `production` enables `Secure` cookies and `trust proxy` |
| `AWS_REGION` | required | region for S3 and DynamoDB |
| `S3_BUCKET` | required | bucket holding documents; no dots unless `S3_ENDPOINT` is set |
| `DYNAMODB_TABLE` | `idv-portal` | single table |
| `S3_ENDPOINT` | unset | local emulator; presigned URLs point at it, so the browser must reach it |
| `DYNAMODB_ENDPOINT` | unset | local emulator |
| `S3_SIGNER_ROLE_ARN` | unset | role assumed through STS to sign presigned URLs; unset means the default credentials sign |
| `MAX_UPLOAD_MB` | `10` | maximum document size; the account page states and checks 10 MB (`public/account.html`, `public/js/account.js`), so change it there too |
| `UPLOAD_URL_TTL_SECONDS` | `300` | lifetime of an upload URL, 60 to 1800 |
| `DOWNLOAD_URL_TTL_SECONDS` | `60` | lifetime of a read URL, 10 to 1800 |
| `SESSION_TTL_DAYS` | `7` | session lifetime |
| `TRUST_PROXY` | `1` in production, `0` otherwise | Express `trust proxy` setting: a hop count, `false` or a subnet list |
| `LOG_LEVEL` | `info` | pino level |

## Local development

```sh
cp .env.example .env      # set AWS_REGION and S3_BUCKET at least
npm ci
npm run db:create-table   # creates DYNAMODB_TABLE; honours DYNAMODB_ENDPOINT
npm run dev               # tsx watch, http://localhost:8080
```

The browser talks to the bucket, so the bucket needs a CORS rule for
`http://localhost:8080`. The `set -a` line exports `.env` for the script:

```sh
set -a; . ./.env; set +a
./deploy/aws/set-bucket-cors.sh http://localhost:8080
```

The rule allows one origin, so this replaces the one a deployment set; see
[Bucket CORS](deploy/aws/README.md#bucket-cors). Without
`S3_SIGNER_ROLE_ARN` your own credentials sign the URLs, so they need
`s3:PutObject` and `s3:GetObject` on the bucket.

Checks:

```sh
npm run typecheck
npm test
npm run build && node --env-file=.env dist/server.js
```

Tests run on Node's built-in test runner with the AWS clients mocked; they make
no network calls. `npm start` expects the variables in the environment, which
is how production runs it; locally, `node --env-file=.env` does the same job.

### Without an AWS account

The service runs against a local S3 and DynamoDB. One LocalStack container
provides both:

```sh
docker run --rm -p 4566:4566 localstack/localstack
```

In `.env`, point both endpoints at it and give the SDK placeholder
credentials; its first call fails without any:

```sh
S3_BUCKET=idv-portal-local
S3_ENDPOINT=http://localhost:4566
DYNAMODB_ENDPOINT=http://localhost:4566
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

Create the bucket and its CORS rule (nothing else does), then the table, then
start the service. The `set -a` line exports `.env` for the AWS CLI, which
does not read it on its own; drop `--create-bucket-configuration` for
`us-east-1`.

```sh
set -a; . ./.env; set +a
aws s3api create-bucket --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION"
AWS_ENDPOINT_URL_S3="$S3_ENDPOINT" ./deploy/aws/set-bucket-cors.sh http://localhost:8080
npm run db:create-table
npm run dev
```

## API

Responses are JSON unless stated. Errors have the shape
`{ "error": { "code": "snake_case", "message": "..." } }`. Routes marked
"session" answer `401 unauthenticated` without a valid `sid` cookie. Requests
that change state must be same-origin, otherwise `403 cross_site_request`.

| Method | Path | Session | Description |
|---|---|---|---|
| GET | `/` | – | Sign-in page; redirects to `/account` when signed in |
| GET | `/account` | – | Account page; redirects to `/` when signed out |
| POST | `/auth/sign-in` | – | `{ "email" }` → `204` with the session cookie; creates the account on first use. `429 too_many_requests` after 20 attempts per 15 minutes |
| POST | `/auth/sign-out` | – | `204`, deletes the session and clears the cookie |
| GET | `/api/me` | yes | `{ id, email, createdAt }` |
| GET | `/api/documents` | yes | `{ documents: [...] }`, newest first |
| POST | `/api/uploads` | yes | `{ kind, fileName, size, contentType, checksumSha256 }` → `201 { upload: { id, method, url, headers, expiresAt } }`. `kind` is `passport`, `id_card` or `driving_licence`; `contentType` is `image/jpeg`, `image/png` or `image/webp`; `checksumSha256` is the base64 SHA-256 of the file. PUT the file to `url` with exactly `headers`; the body must be `size` bytes |
| POST | `/api/uploads/:id/complete` | yes | No body. `201 { document }` once the file has passed the checks |
| DELETE | `/api/uploads/:id` | yes | `204`; gives up a pending upload, for example after a failed PUT, and deletes its staged object and any copy a failed completion left |
| DELETE | `/api/documents/:id` | yes | `204`; removes the file too |
| GET | `/healthz` | – | `{ status, uptimeSeconds, memory }` |

A document is `{ id, kind, fileName, contentType, size, status, createdAt }`.
`status` is `received` or `rejected`. A received document adds `url`, a read
URL for the file, and `urlExpiresAt`; a rejected one adds `rejectionReason`.

Requesting an upload: `400 invalid_kind`, `empty_file` or `invalid_upload`,
`413 file_too_large`, `415 unsupported_file_type`,
`409 document_limit_reached` (20 documents per account, uploads in progress
included), `429 too_many_requests` (30 uploads per 15 minutes per account),
`502 storage_unavailable` (the URL could not be signed).

Completing an upload: `404 not_found`, `409 upload_in_progress` or
`upload_not_received`, `410 upload_expired`, `502 storage_unavailable` (try
again), and `422` when the file is rejected, with `size_mismatch`,
`type_mismatch`, `unexpected_metadata`, `checksum_mismatch`,
`unsupported_file_type` or `object_changed`. A rejected upload appears in
the list as a rejected document.

Giving up an upload: `404 not_found`, `409 upload_in_progress` while a
completion is processing it. Its place in the cap is free again at once.

Deleting a document: `502 storage_unavailable` keeps the document. So does a
`500` for a record whose stored key is not where this service keeps the
file; nothing is deleted then.

S3 itself answers the PUT: `200` when stored, `403` for a changed header or
an expired URL, `412` when a staged object already exists at that key (the
URL used again before the upload was completed), `400 BadDigest` when the
body does not match the checksum.

Documents and uploads that do not belong to the signed-in user answer
`404 not_found`.

## Deployment

Two scripted paths, both under `deploy/aws/`: App Runner (a source deployment
from GitHub, for accounts that already use it) and a single EC2 instance that
runs the `Dockerfile` image behind Caddy with a Let's Encrypt certificate for
the instance's public IP, which works in any account. Both create the signer
role, the lifecycle rule and the bucket's CORS rule. See
[deploy/aws/README.md](deploy/aws/README.md). This release stores files under
`staging/` and `files/users/`, so give it its own table and bucket rather
than pointing it at storage written by an earlier release (see
[Running beside another deployment](deploy/aws/README.md#running-beside-another-deployment)).
`docker-compose.yml` and
`Caddyfile` at the repository root are that stack and run anywhere Docker does.

## Licence

MIT, see [LICENSE](LICENSE).
