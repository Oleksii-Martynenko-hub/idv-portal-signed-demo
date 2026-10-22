# IDV Portal

Identity verification for customer accounts. A signed-in customer uploads a
photo of an ID document, sees the documents they have uploaded, opens any of
them and can delete one. Files travel browser → this service → S3 and back the
same way; nothing is served from S3 directly.

## Requirements

- Node.js 22 or newer and npm
- An S3 bucket and a DynamoDB table the service may use (`deploy/aws/` creates
  them), or a local stand-in for both (see
  [Without an AWS account](#without-an-aws-account))
- AWS credentials from the default provider chain: the instance role in
  production, a profile or environment variables locally

## Configuration

Environment variables, parsed once at startup in `src/config.ts`.
`.env.example` lists them with comments. The app never loads `.env` itself;
`npm run dev` passes `--env-file=.env`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `NODE_ENV` | `development` | `production` enables `Secure` cookies and `trust proxy` |
| `AWS_REGION` | required | region for S3 and DynamoDB |
| `S3_BUCKET` | required | bucket holding documents |
| `DYNAMODB_TABLE` | `idv-portal` | single table |
| `S3_ENDPOINT` | unset | local emulator |
| `DYNAMODB_ENDPOINT` | unset | local emulator |
| `MAX_UPLOAD_MB` | `10` | maximum document size; the account page states and checks 10 MB (`public/account.html`, `public/js/account.js`), so change it there too |
| `MAX_CONCURRENT_UPLOADS` | `100` | uploads held in memory at once; beyond it the service answers `503` |
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

Create the bucket (nothing else does), then the table, then start the
service. The `set -a` line exports `.env` for the AWS CLI, which does not read
it on its own; drop `--create-bucket-configuration` for `us-east-1`.

```sh
set -a; . ./.env; set +a
aws s3api create-bucket --endpoint-url "$S3_ENDPOINT" --bucket "$S3_BUCKET" \
  --create-bucket-configuration "LocationConstraint=$AWS_REGION"
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
| POST | `/api/documents` | yes | `multipart/form-data` with `kind` (`passport`, `id_card`, `driving_licence`) and one `file` (JPEG, PNG or WebP, up to `MAX_UPLOAD_MB`) → `201 { document }` |
| GET | `/api/documents/:id/file` | yes | The stored image, served inline |
| DELETE | `/api/documents/:id` | yes | `204` |
| GET | `/healthz` | – | `{ status, uptimeSeconds, memory }` |

Upload errors: `400 invalid_kind`, `empty_file` or `bad_upload`,
`411 length_required`, `413 file_too_large`, `415 unsupported_file_type`,
`409 document_limit_reached` (20 documents per account),
`429 too_many_requests` (30 uploads per 15 minutes per account),
`502 storage_unavailable`, `503 server_busy` (more than
`MAX_CONCURRENT_UPLOADS` in flight). Documents that do not belong to the
signed-in user answer `404 not_found`.

## Deployment

Two scripted paths, both under `deploy/aws/`: App Runner (a source deployment
from GitHub, for accounts that already use it) and a single EC2 instance that
runs the `Dockerfile` image behind Caddy with a Let's Encrypt certificate for
the instance's public IP, which works in any account. See
[deploy/aws/README.md](deploy/aws/README.md). `docker-compose.yml` and
`Caddyfile` at the repository root are that stack and run anywhere Docker does.

## Licence

MIT, see [LICENSE](LICENSE).
