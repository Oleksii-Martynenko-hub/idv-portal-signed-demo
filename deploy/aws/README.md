# Deploying to AWS

Documents live in a private S3 bucket; browsers upload them and read them
back directly through short-lived presigned URLs that the service signs.
Users, sessions and document metadata live in one DynamoDB table. The
scripts in this directory create and remove everything with the AWS CLI and
can be rerun: each one skips resources that already exist. The service
itself runs on one of two paths.

## Choose a path

- **[App Runner](#app-runner)** – a source deployment from GitHub behind a
  managed HTTPS endpoint. App Runner is closed to new customers: accounts
  that already use it can keep creating services and resources, and AWS
  points new workloads to Amazon ECS Express Mode
  ([availability change][availability]). Use this path only if your account
  is one of them.
- **[EC2](#ec2)** – one `t4g.micro` running the `Dockerfile` image behind
  Caddy, which obtains a publicly trusted Let's Encrypt certificate for the
  instance's public IP address. No domain name is needed. Works in any
  account.

Both paths start with the same storage and IAM steps. To run a second
deployment next to an existing one, or to replace one made by an earlier
release, which cannot be upgraded in place, see
[Running beside another deployment](#running-beside-another-deployment).

## Storage and IAM (both paths)

### Prerequisites

- AWS CLI v2 with working credentials. The scripts read `AWS_REGION` and
  `AWS_PROFILE` from the environment and never override them.
- Node.js 22 or newer; `02-create-iam.sh` uses it to compare policy documents.

### Variables

| Variable      | Required | Default      | Used by                                                       |
|---------------|----------|--------------|---------------------------------------------------------------|
| `AWS_REGION`  | yes      | –            | all scripts                                                   |
| `AWS_PROFILE` | no       | CLI default  | all scripts                                                   |
| `S3_BUCKET`   | yes      | –            | 01, 02, 03, set-bucket-cors, teardown, ec2/launch, ec2/deploy |
| `APP_NAME`    | no       | `idv-portal` | 02, 03, pause, resume, teardown, ec2/*                        |
| `TABLE_NAME`  | no       | `idv-portal` | 01, 02, 03, teardown, ec2/launch, ec2/deploy                  |
| `APP_ORIGIN`  | no       | –            | set-bucket-cors, when no origin is passed as the argument     |

Bucket names are global; `idv-portal-<account-id>` is a safe choice. Keep
the name free of dots: browsers reach the bucket at
`https://<bucket>.s3.<region>.amazonaws.com`, which S3's certificate does
not cover for a dotted name ([virtual-hosted-style requests][virtualhost]),
and the service refuses such a name at startup.

### Create the storage, the policy and the roles

```sh
export AWS_REGION=eu-west-1 AWS_PROFILE=<profile> S3_BUCKET=idv-portal-123456789012

./deploy/aws/01-create-storage.sh
./deploy/aws/02-create-iam.sh
```

1. **`01-create-storage.sh`** – the bucket with all public access blocked,
   the [bucket policy and lifecycle rules](#bucket-policy-and-lifecycle)
   below (S3 applies SSE-S3 encryption to new buckets by default, so nothing
   else is needed), and the table with `PK`/`SK` string keys, on-demand
   capacity and TTL on the `ttl` attribute. Waits until the table is active.
   It leaves CORS alone: the origin is only known once the service is
   deployed, and the deploy scripts set it ([Bucket CORS](#bucket-cors)).
2. **`02-create-iam.sh`** – the `<APP_NAME>-app` policy from
   `iam/app-policy.json` with the bucket, table and signer role ARNs
   substituted; the `<APP_NAME>-instance` role trusted by
   `tasks.apprunner.amazonaws.com`, with the policy attached; and the
   `<APP_NAME>-signer` role with the trust policy from
   `iam/signer-trust.json` and the inline policy `signer` from
   `iam/signer-policy.json`. When the managed policy already exists and its
   document differs (another bucket or table, or a change to
   `app-policy.json`), the script publishes the rendered document as the new
   default version, dropping the oldest version first if IAM's limit of five
   is reached. The signer role's trust policy and inline policy are rewritten
   when they differ from the templates. The EC2 path attaches the same
   managed policy to its own role and ignores the App Runner role. The script
   prints the signer role's ARN; the deploy scripts pass it to the service as
   `S3_SIGNER_ROLE_ARN`.

### Roles and what they may do

The service works with two sets of credentials. Its own role makes its API
calls. A presigned URL carries the permissions of the credentials that
signed it, so URLs are signed with a session of a separate signer role
instead, which can do nothing beyond what a browser is sent to do.

| Role | Created by | Used for | S3 | Other |
|---|---|---|---|---|
| `<APP_NAME>-instance` (App Runner) or `<APP_NAME>-ec2` (EC2), with the `<APP_NAME>-app` policy | `02-create-iam.sh`, `ec2/launch.sh` | The service's own calls: checking a staged upload, copying it to `files/`, deleting objects | `GetObject` and `DeleteObject` on `staging/*`; `PutObject`, `GetObject` and `DeleteObject` on `files/*` | `GetItem`, `PutItem`, `DeleteItem`, `Query`, `TransactWriteItems` and `UpdateItem` on the table; `sts:AssumeRole` on the signer role |
| `<APP_NAME>-signer` | `02-create-iam.sh` | Signing presigned URLs | `PutObject` on `staging/users/*`; `GetObject` on `files/users/*` | – |

Neither role has `ListBucket`, so S3 answers `403` rather than `404` for a
key that does not exist; the service treats both as "not uploaded".

- The service calls STS `AssumeRole` for `S3_SIGNER_ROLE_ARN` with its own
  role's credentials and asks for one-hour sessions. Assuming a role from a
  role session is role chaining, which caps the session at one hour
  ([role chaining][rolechaining], [AssumeRole][assumerole]). A URL signed
  with temporary credentials stops working when they expire
  ([presigned URLs][presigned]), so before signing the service replaces a
  session that would expire before the URL does, with a minute to spare for
  clock skew. Upload URLs last 5 minutes and read URLs 60 seconds
  (`UPLOAD_URL_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`).
- The signer role's trust policy names the account
  (`arn:aws:iam::<account-id>:root`) with an `ArnEquals` condition on
  `aws:PrincipalArn` that lists both service roles. IAM refuses a trust
  policy whose principal is a role that does not exist yet, and the EC2 role
  only appears when `ec2/launch.sh` runs; a condition also keeps matching
  when a role is deleted and recreated under the same name, which a role
  principal does not ([Principal element][iamprincipal]). Because the trust
  policy names the account, a caller also needs `sts:AssumeRole` in its own
  policy; `<APP_NAME>-app` grants it for the signer role only.

### Bucket policy and lifecycle

The bucket policy has two statements:

- `RequireTLS` denies every request not made over TLS.
- `RequireCreateOnlyStagingWrites` denies `PutObject` under `staging/` when
  the request has no `If-None-Match` header (condition key
  `s3:if-none-match`), so a write there can create a key but never replace
  one ([enforcing conditional writes][condwritesenforce]). Upload URLs are
  signed with `If-None-Match: *`, and S3 answers `412 Precondition Failed`
  when the key already exists ([conditional writes][condwrites]). The
  statement covers `staging/` only: S3 refuses `CopyObject` into a bucket or
  prefix that enforces conditional writes, and the service moves an accepted
  upload to `files/` with a copy.

Create-only means a `PUT` can never replace a staged object; it does not
make the URL single-use. Once the service has accepted or rejected an upload
it deletes the staged object, so until the URL expires the same bytes can be
written to that key again. Nothing completes such a copy, and the
`expire-staging` rule below removes it.

The lifecycle configuration has two rules:

- `expire-staging` – objects under `staging/` expire one day after they were
  created. The service deletes a staged object as soon as it has accepted or
  rejected it; the rule removes what is left by uploads that were never
  completed or whose clean-up failed, and copies written again with an upload
  URL after the service deleted the first one. S3 rounds the expiry up to
  the next midnight UTC and removes expired objects asynchronously, so a
  staged object can stay visible for 24 to 48 hours or longer, but it is not
  billed after it expires ([lifecycle rules][lifecyclerules],
  [setting a lifecycle configuration][lifecycleconfig]).
- `abort-incomplete-multipart-uploads` – incomplete multipart uploads
  anywhere in the bucket are aborted after one day
  ([aborting incomplete multipart uploads][mpuabort]). The service only
  issues single-request uploads, so this is housekeeping.

`put-bucket-policy` and `put-bucket-lifecycle-configuration` replace the
whole policy and lifecycle configuration, so rerunning `01-create-storage.sh`
removes statements or rules added by hand.

### Bucket CORS

Browsers send uploads and reads straight to
`https://<bucket>.s3.<region>.amazonaws.com`, which is a different origin
from the service. An upload is a `PUT` with headers that are not
CORS-safelisted (`Content-Type: image/jpeg` and the like, `Cache-Control`,
`Content-Disposition`, `If-None-Match`, `x-amz-checksum-sha256`), so the
browser first sends a preflight `OPTIONS` request, which S3 answers from the
bucket's CORS configuration ([CORS][s3cors],
[CORS configuration][s3corsconfig]). `set-bucket-cors.sh <origin>` writes a
single rule:

| Field            | Value |
|------------------|-------|
| `AllowedOrigins` | the origin passed in, e.g. `https://203.0.113.10` |
| `AllowedMethods` | `PUT`, `GET` |
| `AllowedHeaders` | `content-type`, `cache-control`, `content-disposition`, `if-none-match`, `x-amz-checksum-sha256`: the headers signed into each upload URL |
| `ExposeHeaders`  | `ETag` |
| `MaxAgeSeconds`  | `600`; browsers may reuse a preflight answer for ten minutes |

The script accepts `https://<host>[:port]`, and `http://localhost[:port]` or
`http://127.0.0.1[:port]` for local development, without a path; it takes
the origin from `APP_ORIGIN` when no argument is given. With
`AWS_ENDPOINT_URL_S3` set, the CLI sends the request to that endpoint
instead, for example LocalStack.

The rule is set:

- by `ec2/deploy.sh` on every deployment, for `https://<PUBLIC_HOST>`: the
  instance's public IP changes whenever it is stopped and started, and
  `PUBLIC_HOST` can switch to a DNS name;
- by `03-create-service.sh` once the service is `RUNNING`, for
  `https://<service URL>`; the URL stays the same across deployments, pause
  and resume, so the rule stays valid;
- by hand for local development:
  `./deploy/aws/set-bucket-cors.sh http://localhost:8080`.

`put-bucket-cors` replaces the whole configuration, so the bucket accepts
one origin at a time and the last call wins. Give every deployment, and
local development, a bucket of its own.

CORS decides what pages in a browser may do; what an upload may write is
fixed by its signature. When the origin does not match, the browser reports
the upload as a network error and the page cannot read S3's `403` answer to
the preflight ([troubleshooting CORS][s3corstrouble]).

### When uploads fail

- **The browser reports a network error on the upload.** Usually the
  bucket's CORS rule names another origin, because something else set it
  last. Check with
  `aws s3api get-bucket-cors --bucket "$S3_BUCKET" --region "$AWS_REGION"`
  and set it again: `ec2/deploy.sh`, or `set-bucket-cors.sh` with the
  service URL.
- **Uploads fail with `502 storage_unavailable`.** The service could not
  assume the signer role: the role is missing or the `<APP_NAME>-app`
  policy does not grant `sts:AssumeRole` on it (rerun `02-create-iam.sh`
  with this deployment's variables), `S3_SIGNER_ROLE_ARN` names another
  role, or the role was created seconds ago and IAM has not caught up. The
  service log shows the STS error.
- **S3 answers the upload's `PUT` with `403`** (the page says the upload
  was not accepted). Usually `S3_SIGNER_ROLE_ARN` is unset or wrong, so the
  URL was signed by credentials that may not write to `staging/`: without
  the variable the service's own role signs, and it has no `PutObject` on
  `staging/*`. The `server listening` line the service logs at startup has
  a `signer` field, `role` when it assumes `S3_SIGNER_ROLE_ARN` and
  `default chain` when its own credentials sign. An expired URL or a header
  changed after signing gets `403` as well.

## App Runner

The service runs as an App Runner source deployment: App Runner pulls the
repository from GitHub, builds it with the managed Node.js 22 runtime and runs
a single instance behind a managed HTTPS endpoint.

### Prerequisites

- The repository pushed to GitHub, including the branch to deploy.
- A GitHub connection in the App Runner console for the target region:
  **Connected accounts → Add new → GitHub**, then complete the handshake with
  the AWS Connector for GitHub app. The CLI can create the connection resource
  (`aws apprunner create-connection`), but the handshake itself can only be
  completed in the console, and the connection is unusable until then
  ([connections][connections]). Connections are regional and can be shared by
  several services.

  ```sh
  aws apprunner list-connections --region "$AWS_REGION" \
    --query 'ConnectionSummaryList[].[ConnectionName,Status,ConnectionArn]' --output table
  ```

### Variables

| Variable         | Required | Default | Used by |
|------------------|----------|---------|---------|
| `CONNECTION_ARN` | yes      | –       | 03      |
| `REPO_URL`       | yes      | –       | 03      |
| `BRANCH`         | no       | `main`  | 03      |

### Create the service

```sh
CONNECTION_ARN=arn:aws:apprunner:eu-west-1:123456789012:connection/github/... \
REPO_URL=https://github.com/<owner>/<repo> \
./deploy/aws/03-create-service.sh
```

**`03-create-service.sh`** checks that the signer role exists, creates an
auto scaling configuration named `<APP_NAME>` with min 1 / max 1 and 100
concurrent requests per instance (App Runner's default), then the service:
0.25 vCPU / 0.5 GB, the instance role, HTTP health check on `/healthz`,
automatic deployments off, runtime variables `NODE_ENV`, `AWS_REGION`,
`S3_BUCKET`, `DYNAMODB_TABLE` and `S3_SIGNER_ROLE_ARN`
(`arn:aws:iam::<account-id>:role/<APP_NAME>-signer`). It polls until the
service is `RUNNING`, sets the bucket's CORS rule for
`https://<service URL>` and prints the URL. The first build and deployment
takes several minutes. If the script is interrupted or times out after
creating the service, run it again once the service is `RUNNING`: it finds
the service, checks that it runs with this `S3_BUCKET` and an
`S3_SIGNER_ROLE_ARN`, sets the CORS rule and prints the URL. It also prints
the `set-bucket-cors.sh` command for the service URL as soon as the service
is created. If the first deployment fails (`CREATE_FAILED`), fix the cause
shown in the service event log, push the branch and rebuild the service
(**Rebuild** in the console, or `aws apprunner update-service` with the same
values; [rebuilding a failed service][rebuild]), or delete only the service
with `aws apprunner delete-service` and run the script again: `teardown.sh`
would delete the bucket, table and roles as well.

IAM is eventually consistent: if the script reports the instance role as
invalid right after `02-create-iam.sh`, wait a few seconds and run it again.

Requests to the service are small JSON calls; files travel between the
browser and S3, so neither the instance's memory nor the request cap limits
uploads. Changing `--max-concurrency` on a running service means creating a
new revision of the configuration (`create-auto-scaling-configuration` with
the same name) and pointing the service at it with `update-service
--auto-scaling-configuration-arn`.

#### Build configuration: API values and `apprunner.yaml`

App Runner reads a source service's build and run settings from exactly one
place: `apprunner.yaml` in the repository (`ConfigurationSource: REPOSITORY`)
or the values passed in the API call (`ConfigurationSource: API`). In
repository mode the API values, including runtime environment variables, are
ignored ([CodeConfiguration][codeconfig]). The bucket, table, region and
signer role differ per deployment and do not belong in the repository, so
the script configures the service through the API: build `npm ci && npm run
build && npm prune --omit=dev`, start `npm start`, port 8080.
`apprunner.yaml` at the repository root carries the same steps for a service
created from the console with **Use a configuration file**; in that mode
`AWS_REGION`, `S3_BUCKET`, `DYNAMODB_TABLE` and `S3_SIGNER_ROLE_ARN` have to
be added to its `run.env` section or referenced from Parameter Store under
`run.secrets`, and the bucket's CORS rule set with `set-bucket-cors.sh` once
the service URL is known. App Runner reads referenced parameters with the
instance role, which then needs `ssm:GetParameters` on them;
`<APP_NAME>-app` does not grant it
([referencing environment variables][envvars]).

### Redeploy

Automatic deployments are off, so pushing to the branch changes nothing until
a deployment is started. App Runner then builds the latest commit of the
configured branch and replaces the running instance.

```sh
service_arn=$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${APP_NAME:-idv-portal}'].ServiceArn | [0]" --output text)
aws apprunner start-deployment --region "$AWS_REGION" --service-arn "$service_arn"
```

Progress shows in the console event log, or `describe-service` returns
`Service.Status` to `RUNNING`. Runtime environment variables are part of the
service configuration; change them in the console (Configuration tab) or with
`aws apprunner update-service`.

The service URL does not change on a redeployment, so the bucket's CORS rule
set by `03-create-service.sh` stays valid. If it was replaced since (for
example by local development against the same bucket), restore it with
`./deploy/aws/set-bucket-cors.sh https://<service URL>`.

### Platform limits

| Limit | Value | Effect on this service |
|---|---|---|
| Request timeout | 120 seconds in total, including reading the request body and writing the response | Only API calls pass through App Runner; files go between the browser and S3, so the timeout does not limit uploads or downloads. |
| Request body size | Not documented by App Runner | Requests to the service are small JSON bodies; documents, up to `MAX_UPLOAD_MB` (default 10 MB), go to S3 directly. |
| HTTP | HTTP/1.0 and 1.1 to the container; TLS terminated by App Runner; plain HTTP redirected to HTTPS | `NODE_ENV=production` turns on `Secure` cookies and `trust proxy`. |
| Port | App Runner injects `PORT` with the configured port (8080) and reserves that variable name | The service listens on `PORT`, default 8080. |
| Instance startup | Must be listening and healthy within 5 minutes | Startup takes seconds. |
| Ephemeral storage | 3 GB per instance, shared with the container image; not preserved across pause/resume or instance replacement | Nothing is written to disk. The service reads only the first few KB of each upload back from S3 to check its format. |
| Instance size | 0.25 vCPU / 0.5 GB, the smallest supported combination | Enough for this service: apart from the first few KB of each upload, file bytes do not pass through the instance. |
| Scaling | Auto scaling configuration with min 1 / max 1 and max concurrency 100 (App Runner's default) | One instance handling at most 100 requests at a time. Raise `--max-size` in `03-create-service.sh` to scale out. |
| Paused service | Compute removed and ephemeral state discarded; configuration, built image and URL kept | See [Pause and resume](#pause-and-resume). |
| CPU architecture | `linux/amd64` | Build images for `linux/amd64`; see the image path below. |
| Runtime | Managed `nodejs22` runtime; newest listed version `22.21.1`. Node.js 18 and earlier reach end of support on 1 December 2025 | `apprunner.yaml` pins `22.21.1`; move it forward when AWS lists a newer release. |
| Health check | HTTP `GET /healthz` every 10 s, 5 s timeout, unhealthy after 5 failures | `/healthz` needs no session. |
| Quotas | 30 services, 10 connections and 10 auto scaling configuration names per region (adjustable); 5 revisions per configuration name | – |

### Cost

App Runner bills on the dimensions below ([pricing][pricing]). Rates depend on
the region and change over time, so read the pricing page rather than this
file.

- Provisioned instance memory (GB-hour) for every running instance, idle or
  not. With min size 1 this accrues around the clock while the service runs.
- Active instance compute: vCPU-hour and memory GB-hour while the instance
  handles requests, billed per second with a one-minute minimum each time an
  instance starts handling requests.
- Build time for each source deployment.
- Automatic deployments carry a fixed monthly fee per service; they are
  disabled here, so a manual deployment costs build time only.
- Data transfer and CloudWatch Logs are billed by those services.
- S3 (storage, requests) and DynamoDB (on-demand reads and writes, storage)
  are billed separately by those services. Each upload takes a handful of S3
  requests: the browser's `PUT`, then the service's `HEAD`, ranged `GET` and
  copy; S3 does not bill deletions ([S3 pricing][s3pricing]).
- The lifecycle rules and the CORS rule have no charge of their own, and
  STS `AssumeRole` calls are free: IAM and STS are offered at no additional
  charge ([IAM and STS pricing][iamintro]).

A paused service is not billed for instances: AWS states that you are only
billed while the application is running. Data in S3 and DynamoDB continues to
be billed.

### Pause and resume

```sh
./deploy/aws/pause.sh
./deploy/aws/resume.sh
```

Pausing reduces compute to zero and discards ephemeral storage; the service
configuration, the built image and the URL are kept, and resuming provisions
new compute without a rebuild. Both operations are asynchronous:
`describe-service` reports `OPERATION_IN_PROGRESS`, then `PAUSED` or
`RUNNING`. Pausing does not touch the bucket or the table, and the bucket's
CORS rule stays valid because the URL is kept.

### Teardown

```sh
./deploy/aws/teardown.sh
```

The script lists what it is about to delete and asks you to type the
application name. It then deletes the service (waiting until it is gone),
empties and deletes the bucket (its policy, lifecycle and CORS rules go with
it), deletes the table, the instance role and the signer role (its inline
policy first), detaches the policy from every role that still has it (the
EC2 role included) and deletes it with its older versions, and deletes all
revisions of the auto scaling configuration, which is only possible once no
service uses it. The GitHub connection is left in place; remove it under
**Connected accounts** in the console or with
`aws apprunner delete-connection` if nothing else uses it.

### Alternative: deploy the container image from ECR

The source path needs no Docker locally. To build the image yourself, or to
run the service elsewhere, use the `Dockerfile` at the repository root.

1. Build for `linux/amd64` and push to a private ECR repository:

   ```sh
   account_id=$(aws sts get-caller-identity --query Account --output text)
   registry="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
   tag="$(git rev-parse --short HEAD)"

   aws ecr create-repository --region "$AWS_REGION" --repository-name "${APP_NAME:-idv-portal}"
   aws ecr get-login-password --region "$AWS_REGION" \
     | docker login --username AWS --password-stdin "$registry"
   docker buildx build --platform linux/amd64 -t "${registry}/${APP_NAME:-idv-portal}:${tag}" --push .
   ```

2. Create the access role App Runner uses to pull from ECR. It is trusted by
   `build.apprunner.amazonaws.com` (not `tasks.`) and uses the AWS managed
   policy:

   ```sh
   aws iam create-role --role-name "${APP_NAME:-idv-portal}-ecr-access" \
     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam attach-role-policy --role-name "${APP_NAME:-idv-portal}-ecr-access" \
     --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
   ```

3. Create the service from the image. Storage, the instance and signer roles
   and the auto scaling configuration are the same as on the source path (run
   steps 1 and 2 above first); only `SourceConfiguration` differs. Replace
   `<APP_NAME>` with the deployment's `APP_NAME` (default `idv-portal`) and
   `<table>` with its `TABLE_NAME`:

   ```json
   {
     "ServiceName": "<APP_NAME>",
     "SourceConfiguration": {
       "AuthenticationConfiguration": {
         "AccessRoleArn": "arn:aws:iam::<account-id>:role/<APP_NAME>-ecr-access"
       },
       "AutoDeploymentsEnabled": false,
       "ImageRepository": {
         "ImageIdentifier": "<account-id>.dkr.ecr.<region>.amazonaws.com/<APP_NAME>:<tag>",
         "ImageRepositoryType": "ECR",
         "ImageConfiguration": {
           "Port": "8080",
           "RuntimeEnvironmentVariables": {
             "NODE_ENV": "production",
             "AWS_REGION": "<region>",
             "S3_BUCKET": "<bucket>",
             "DYNAMODB_TABLE": "<table>",
             "S3_SIGNER_ROLE_ARN": "arn:aws:iam::<account-id>:role/<APP_NAME>-signer"
           }
         }
       }
     },
     "InstanceConfiguration": {
       "Cpu": "0.25 vCPU",
       "Memory": "0.5 GB",
       "InstanceRoleArn": "arn:aws:iam::<account-id>:role/<APP_NAME>-instance"
     },
     "HealthCheckConfiguration": {
       "Protocol": "HTTP",
       "Path": "/healthz",
       "Interval": 10,
       "Timeout": 5,
       "HealthyThreshold": 1,
       "UnhealthyThreshold": 5
     },
     "AutoScalingConfigurationArn": "arn:aws:apprunner:<region>:<account-id>:autoscalingconfiguration/<APP_NAME>"
   }
   ```

   ```sh
   aws apprunner create-service --region "$AWS_REGION" --cli-input-json file://service.json
   ```

   Once the service is running, allow its URL in the bucket's CORS rule:
   `./deploy/aws/set-bucket-cors.sh https://<service URL>`.

   To redeploy, push a new image to the same tag and run `start-deployment`
   (App Runner pulls the latest image for the configured tag), or point the
   service at a new tag with `update-service`. `pause.sh`, `resume.sh` and
   `teardown.sh` work unchanged; teardown does not delete the ECR repository
   or the access role.

## EC2

One `t4g.micro` (Graviton, Amazon Linux 2023) runs two containers with Docker
Compose: the service image built from the `Dockerfile`, and Caddy, which
terminates TLS on ports 80 and 443 and proxies to the service. Caddy obtains
a publicly trusted certificate for the instance's public IPv4 address from
Let's Encrypt, which has issued IP address certificates since 15 January
2026 through its `shortlived` profile: certificates are valid for 160 hours
and Caddy renews them on its own. No domain name is needed; with
`PUBLIC_HOST` set to a DNS name that resolves to the instance, Caddy requests
the certificate for that name instead.

### Prerequisites

- AWS CLI v2, `git`, `ssh`, `rsync` and `curl` on your machine.
- An IAM principal that can create EC2 and IAM resources: instances, security
  groups, key pairs, roles and instance profiles, and `iam:PassRole` for the
  instance role; and `s3:PutBucketCORS` on the bucket, which `deploy.sh`
  sets on every deployment.
- A default VPC in the region (`aws ec2 create-default-vpc` recreates one).
- `01-create-storage.sh` and `02-create-iam.sh` already run, so the bucket,
  the table, the `<APP_NAME>-app` policy and the `<APP_NAME>-signer` role
  exist. `launch.sh` stops with a message when the policy or the signer role
  is missing, and `deploy.sh` when the signer role is.

### Variables

In addition to `AWS_REGION`, `AWS_PROFILE`, `S3_BUCKET`, `APP_NAME` and
`TABLE_NAME` from the shared table:

| Variable        | Required | Default                                   | Used by          |
|-----------------|----------|-------------------------------------------|------------------|
| `INSTANCE_TYPE` | no       | `t4g.micro`                               | launch           |
| `KEY_FILE`      | no       | `~/.ssh/<APP_NAME>-ec2.pem`               | launch, deploy, teardown |
| `INSTANCE_IP`   | no       | the running instance tagged `Name=<APP_NAME>` | deploy       |
| `PUBLIC_HOST`   | no       | the instance's public IP                  | deploy (through launch) |

`APP_NAME` names the role, instance profile, key pair and security group
(`<APP_NAME>-ec2`) and the instance's `Name` tag.

### Launch and deploy

```sh
export AWS_REGION=eu-west-1 AWS_PROFILE=<profile> S3_BUCKET=idv-portal-123456789012

./deploy/aws/ec2/launch.sh      # first time: creates the instance, then deploys
./deploy/aws/ec2/deploy.sh      # every later deployment
```

**`launch.sh`** checks that the policy and the signer role exist, then
creates, or reuses by name, each of the following, then runs `deploy.sh`:

1. The role `<APP_NAME>-ec2` trusted by `ec2.amazonaws.com`
   (`iam/ec2-instance-trust.json`) with the `<APP_NAME>-app` policy attached,
   and the instance profile `<APP_NAME>-ec2` holding it. The signer role
   already trusts this role by name.
2. The security group `<APP_NAME>-ec2` in the default VPC: tcp/22 from your
   current public address as reported by `https://checkip.amazonaws.com`,
   tcp/80 and tcp/443 from anywhere. Rerunning from another network replaces
   the tcp/22 rule: rules for other addresses are revoked.
3. The key pair `<APP_NAME>-ec2` (ed25519), with the private key saved to
   `KEY_FILE` with mode 0600. The script never overwrites an existing file:
   if the key pair is gone from AWS but the file is still there, or the other
   way round, it stops and says what to do.
4. The instance: the latest Amazon Linux 2023 AMI for the instance type's
   architecture, resolved through the public SSM parameter
   `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-<arch>`,
   in a default subnet of a zone that offers the type, with a public IPv4
   address, IMDSv2 required with a hop limit of 2 (the SDK inside the
   container needs that extra hop to reach the credentials), an encrypted
   gp3 root volume (`/dev/xvda`, the default EBS key), the instance profile,
   `user-data.sh` as user data and the tag `Name=<APP_NAME>`. A new
   instance profile is not visible to EC2 for a few seconds, so the launch is
   retried until it is accepted.
5. Waits for `instance-running` and `instance-status-ok`, prints the public
   IP, waits for SSH and for the first-boot setup to finish.

`user-data.sh` runs once at first boot through cloud-init: it installs Docker
and `rsync` from the distribution, enables Docker, puts `ec2-user` in the
`docker` group, installs the Docker Compose and buildx plugins from their
GitHub releases (AL2023 does not package Compose, and the buildx in its
`docker` package is older than Compose requires; each download is checked
against the published SHA-256), adds a 1 GiB swap file so that `npm ci` and `tsc` survive the
instance's 1 GiB of memory during image builds, and creates `/opt/idv-portal`
owned by `ec2-user`.

If an instance tagged `Name=<APP_NAME>` is already running, `launch.sh` skips
straight to the deployment; a stopped one is started first.

**`deploy.sh`** checks that the signer role exists, finds the running
instance by tag (or takes `INSTANCE_IP`), `rsync`s the files tracked by git
(committed or staged; untracked files are never sent) to `/opt/idv-portal`,
deleting anything there that is no longer tracked except `.env`, writes
`/opt/idv-portal/.env`:

```
NODE_ENV=production
PORT=8080
AWS_REGION=<region>
S3_BUCKET=<bucket>
DYNAMODB_TABLE=<table>
S3_SIGNER_ROLE_ARN=arn:aws:iam::<account-id>:role/<APP_NAME>-signer
TRUST_PROXY=1
PUBLIC_HOST=<public IP, or PUBLIC_HOST if set>
```

then sets the bucket's CORS rule for `https://<PUBLIC_HOST>` with
`set-bucket-cors.sh` ([Bucket CORS](#bucket-cors)), runs
`docker compose up -d --build` over SSH, polls
`https://<PUBLIC_HOST>/healthz` with certificate checks off until it answers
`200` (the first certificate takes a short while), and finally requests it
once more with certificate checks on, which only succeeds when the
certificate chains to a trusted root. It prints the URL.

### What the instance runs

`/opt/idv-portal` holds the files tracked by git, the `.env` written by
`deploy.sh`, and `docker-compose.yml` and `Caddyfile` from the repository
root.

- **`app`** – built from the `Dockerfile` on the instance; listens on 8080
  inside the compose network only. `TRUST_PROXY=1` because Caddy is the one
  proxy hop and sets `X-Forwarded-For` and `X-Forwarded-Proto`. AWS
  credentials come from the instance role through IMDSv2; the service
  assumes the signer role with them to sign URLs. The container is limited
  to 768 MiB of memory (`mem_limit`); if it exceeds that, Docker restarts
  it, and Caddy and SSH stay up.
- **`caddy`** (`caddy:2.11.7`) – publishes 80 and 443. Port 80 answers the
  ACME HTTP-01 challenge and redirects everything else to HTTPS. The site
  address is `PUBLIC_HOST`; `tls { issuer acme { profile shortlived } }`
  asks Let's Encrypt for the `shortlived` profile, the only one of its
  profiles that issues for IP addresses. Clients send no SNI when they
  connect to an IP address, and behind Docker's port mapping the connection
  arrives on the container's address, so the `default_sni` global option
  names the certificate to serve. Certificates and the ACME account key are
  stored in the `caddy_data` volume. Caddy is pinned to 2.11.7; older
  releases refused IP identifiers or failed the TLS-ALPN challenge for them
  ([caddyserver/caddy issue 7399][caddy7399]), so do not move the tag
  backwards.

Both containers have `restart: unless-stopped` and come back with Docker
after a reboot.

### Watching it

```sh
ssh -i "${KEY_FILE:-$HOME/.ssh/${APP_NAME:-idv-portal}-ec2.pem}" ec2-user@<public-ip>
cd /opt/idv-portal
docker compose ps
docker compose logs -f               # add a service name (app, caddy) for one of them
docker stats --no-stream
sudo tail -n 50 /var/log/cloud-init-output.log   # first-boot setup
```

### Cost

EC2 bills on the dimensions below; rates depend on the region, so read the
pricing pages ([On-Demand][ec2pricing], [public IPv4][vpcpricing],
[EBS][ebspricing]) rather than this file.

- Instance time: On-Demand, per second while the instance is running, with a
  60-second minimum each time it starts. A stopped instance is not billed for
  instance time.
- Burstable CPU: T4g instances launch in unlimited mode. If the average CPU
  use over 24 hours exceeds the instance's baseline, the excess is billed per
  vCPU-hour as surplus credits.
- Public IPv4 address: per hour while it is attached to the running instance.
- The EBS root volume: per GB-month, also while the instance is stopped.
- Data transfer out to the internet: per GB.
- S3 (storage, requests) and DynamoDB (on-demand reads and writes, storage)
  are billed separately by those services ([S3][s3pricing],
  [DynamoDB][dynamodbpricing]). The lifecycle and CORS rules have no charge
  of their own, and STS calls are free ([IAM and STS pricing][iamintro]).

As an estimate, a short test of this path, with the instance running for a
day or two and then torn down, comes to around one US dollar in total: the
`t4g.micro` On-Demand rate and the public IPv4 address together cost roughly
1.5 US cents per hour, the 8 GiB gp3 root volume (the AMI's default size) a
few cents for those days, and S3 and DynamoDB a negligible amount for a
handful of documents. Check the pricing pages above for your region before
relying on this.

### Stop, start and teardown

To pause the cost of the instance, stop it; the volume and the configuration
on it are kept:

```sh
instance_id=$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${APP_NAME:-idv-portal}" Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId | [0]' --output text)
aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$instance_id"
```

EC2 releases the public IPv4 address when the instance stops and assigns a
new one when it starts, so bring it back with `./deploy/aws/ec2/launch.sh`,
which starts the instance and redeploys with the new address, pointing the
bucket's CORS rule at it as well.

```sh
./deploy/aws/ec2/teardown.sh
./deploy/aws/teardown.sh
```

`ec2/teardown.sh` asks you to type the application name, then terminates the
instance and waits for it, deletes the security group (retrying until the
instance's network interface is gone), the key pair and the local private
key, the instance profile and the role, and drops the instance's host key
from `~/.ssh/known_hosts`. The bucket, table, application policy and signer
role are left for `deploy/aws/teardown.sh`, which skips the App Runner
service and auto scaling configuration when there are none.

### Troubleshooting

See also [When uploads fail](#when-uploads-fail).

- **No certificate, or the TLS handshake fails.** Let's Encrypt validates an
  IP address with the HTTP-01 or TLS-ALPN-01 challenge (DNS-01 cannot), so
  ports 80 and 443 must be reachable from the internet, not only from your
  network. `launch.sh` opens both in the security group; check that nothing
  else (a network ACL, a changed rule) is in the way, then
  `docker compose logs caddy` on the instance.
- **The public IP changed after a stop/start.** The old address is gone and
  `.env` still names it. Run `./deploy/aws/ec2/deploy.sh` (or `launch.sh`,
  which does the same after starting the instance): it writes the new
  `PUBLIC_HOST`, points the bucket's CORS rule at it, and Caddy obtains a
  certificate for it.
- **Let's Encrypt limits.** Up to 5 authorization failures per identifier can
  be incurred by one account every hour; after that, orders for that address
  are refused until the window passes, so fix the cause (usually the ports)
  before retrying. Up to 5 certificates can be issued per exact set of
  identifiers every 7 days: keep the `caddy_data` volume across deployments.
  `docker compose down -v` discards the certificate and the next start
  requests a new one.
- **SSH is refused from a new network.** The security group allows tcp/22
  only from the address `launch.sh` saw at the time; rerun it to switch the
  rule to the current one.
- **SSH warns that the host key changed.** The address was reused by a new
  instance: `ssh-keygen -R <public-ip>`, then retry.
- **The image build is killed on the instance.** 1 GiB of memory plus the
  swap file is enough for this project; for a heavier build set
  `INSTANCE_TYPE=t4g.small` (or larger) when launching.

## Running beside another deployment

This release keeps objects under `staging/` and `files/users/`, and its
policies cover only those prefixes, so it does not read documents an
earlier release stored under `users/<user>/documents/`. A deployment made
by an earlier release, App Runner service included, therefore cannot be
upgraded in place: its storage uses the earlier layout. Create this release
with new `APP_NAME`, `TABLE_NAME` and `S3_BUCKET`, and once the old
deployment is no longer needed, remove it with `teardown.sh` run under its
own names (after `ec2/teardown.sh` for an EC2 deployment).

Every AWS name the scripts use derives from three variables. `APP_NAME`
names the policy `<APP_NAME>-app`, the roles `<APP_NAME>-instance`,
`<APP_NAME>-signer` and `<APP_NAME>-ec2`, the EC2 instance profile, key pair
and security group, the instance's `Name` tag, the App Runner service and
auto scaling configuration, and the default `KEY_FILE`; `TABLE_NAME` names
the table; `S3_BUCKET` the bucket. Set all three to new values to run a
second deployment next to an existing one in the same account and region:

```sh
export AWS_REGION=eu-west-1 AWS_PROFILE=<profile>
export APP_NAME=idv-portal-signed TABLE_NAME=idv-portal-signed S3_BUCKET=idv-portal-signed-123456789012
```

Keep the three exported in every shell that runs a script for that
deployment, teardown included: without them a script falls back to the
`idv-portal` names of the other deployment. The teardown scripts ask you to
type the application name, which shows which set they are about to delete.
A separate bucket matters as much as a separate table: the bucket's CORS
rule holds one origin, so two deployments on one bucket would keep
replacing each other's.

The commands written out under [Redeploy](#redeploy),
[Watching it](#watching-it) and
[Stop, start and teardown](#stop-start-and-teardown), and the shell steps of
the [ECR image path](#alternative-deploy-the-container-image-from-ecr),
read `APP_NAME` (and `KEY_FILE`) from the same shell; in that path's
`service.json`, write the new names in place of `<APP_NAME>` and `<table>`.

**EC2.** `deploy.sh` ships the files git tracks in the checkout it is run
from, as they are on disk. Run each deployment's scripts from its own
checkout, with that deployment's three variables exported:

```sh
./deploy/aws/01-create-storage.sh
./deploy/aws/02-create-iam.sh
./deploy/aws/ec2/launch.sh
```

Later deployments run `./deploy/aws/ec2/deploy.sh` from the same checkout.

**App Runner.** App Runner builds from GitHub, not from a local checkout:
push the repository and pass its URL as `REPO_URL`, and `BRANCH` if it is
not `main`. The GitHub connection can be shared by both services. After
`01-create-storage.sh` and `02-create-iam.sh` with the variables above:

```sh
CONNECTION_ARN=arn:aws:apprunner:eu-west-1:123456789012:connection/github/... \
REPO_URL=https://github.com/<owner>/<repo> \
./deploy/aws/03-create-service.sh
```

## References

- [AWS App Runner availability change][availability]
- [Configuration file reference][configref] (`apprunner.yaml` keys)
- [Node.js platform][nodejs] and [Node.js runtime releases][nodejsreleases]
- [Developing application code for App Runner][develop] (request timeout, `PORT`, ephemeral storage, startup time)
- [Architecture and concepts][architecture] (instance sizes, quotas)
- [Referencing environment variables][envvars] (`PORT` is reserved; instance role permissions for Parameter Store)
- [How App Runner works with IAM][iam] (instance role and access role trust policies)
- [Managing connections][connections]
- [Deploying a new application version][deploy] (manual vs automatic deployments)
- [Configuring health checks][healthcheck]
- [Rebuilding a failed service][rebuild] (`update-service` or **Rebuild** after `CREATE_FAILED`)
- [Deleting a service][delete] (pause vs delete)
- [CodeConfiguration][codeconfig] (`REPOSITORY` vs `API`)
- [create-service][createservice], [create-auto-scaling-configuration][createasc], [pause-service][pause], [resume-service][resume], [start-deployment][startdeployment]
- [App Runner pricing][pricing]
- [S3 default encryption FAQ][s3encryption] and [bucket policy examples][s3policies] (TLS-only policy)
- [Presigned URLs][presigned] (expiry with temporary credentials) and [uploading with a presigned URL][presignedupload]
- [Virtual-hosted-style requests][virtualhost] (bucket names with dots)
- [CORS][s3cors], [CORS configuration][s3corsconfig] (`AllowedHeaders` matching), [troubleshooting CORS][s3corstrouble]
- [Lifecycle rules][lifecyclerules] (expiry rounded to midnight UTC), [setting a lifecycle configuration][lifecycleconfig] (replacement, delays, billing), [aborting incomplete multipart uploads][mpuabort]
- [Conditional writes][condwrites] (`If-None-Match: *`), [enforcing conditional writes][condwritesenforce] (`s3:if-none-match`, copies into an enforced prefix)
- [Role chaining][rolechaining] (one-hour sessions), [AssumeRole][assumerole] (`DurationSeconds`)
- [Principal element][iamprincipal] (account principals, `aws:PrincipalArn`, recreated roles)
- [IAM and STS pricing][iamintro], [S3 pricing][s3pricing], [DynamoDB on-demand pricing][dynamodbpricing]
- [Let's Encrypt: short-lived and IP address certificates][leipcerts], [certificate profiles][leprofiles], [rate limits][leratelimits], [challenge types][lechallenges]
- [Caddy `tls` directive][caddytls] (`issuer acme`, `profile`), [global options][caddyoptions] (`default_sni`), [Caddy image][caddyimage]
- [Launching AL2023 with the SSM parameter][al2023ssm]
- [IAM roles for Amazon EC2][ec2iamroles] (instance profiles), [IAM eventual consistency][iamconsistency]
- [Security groups in the AWS CLI][clisg] (`checkip.amazonaws.com`)
- [EC2 instance IP addressing][ec2addressing] (public IPv4 released on stop)
- [On-Demand Instances][ec2ondemand] (per-second billing), [unlimited mode for burstable instances][burstable]
- [EC2 On-Demand pricing][ec2pricing], [VPC pricing][vpcpricing] (public IPv4), [EBS pricing][ebspricing]
- [Docker Compose plugin manual install][composeinstall]

[availability]: https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html
[configref]: https://docs.aws.amazon.com/apprunner/latest/dg/config-file-ref.html
[nodejs]: https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code-nodejs.html
[nodejsreleases]: https://docs.aws.amazon.com/apprunner/latest/dg/service-source-code-nodejs-releases.html
[develop]: https://docs.aws.amazon.com/apprunner/latest/dg/develop.html
[architecture]: https://docs.aws.amazon.com/apprunner/latest/dg/architecture.html
[envvars]: https://docs.aws.amazon.com/apprunner/latest/dg/env-variable.html
[iam]: https://docs.aws.amazon.com/apprunner/latest/dg/security_iam_service-with-iam.html
[connections]: https://docs.aws.amazon.com/apprunner/latest/dg/manage-connections.html
[deploy]: https://docs.aws.amazon.com/apprunner/latest/dg/manage-deploy.html
[healthcheck]: https://docs.aws.amazon.com/apprunner/latest/dg/manage-configure-healthcheck.html
[rebuild]: https://docs.aws.amazon.com/apprunner/latest/dg/manage-rebuild.html
[delete]: https://docs.aws.amazon.com/apprunner/latest/dg/manage-delete.html
[codeconfig]: https://docs.aws.amazon.com/apprunner/latest/api/API_CodeConfiguration.html
[createservice]: https://docs.aws.amazon.com/cli/latest/reference/apprunner/create-service.html
[createasc]: https://docs.aws.amazon.com/cli/latest/reference/apprunner/create-auto-scaling-configuration.html
[pause]: https://docs.aws.amazon.com/cli/latest/reference/apprunner/pause-service.html
[resume]: https://docs.aws.amazon.com/cli/latest/reference/apprunner/resume-service.html
[startdeployment]: https://docs.aws.amazon.com/cli/latest/reference/apprunner/start-deployment.html
[pricing]: https://aws.amazon.com/apprunner/pricing/
[s3encryption]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html
[s3policies]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies.html
[presigned]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html
[presignedupload]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html
[virtualhost]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html
[s3cors]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html
[s3corsconfig]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html
[s3corstrouble]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors-troubleshooting.html
[lifecyclerules]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/intro-lifecycle-rules.html
[lifecycleconfig]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html
[mpuabort]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html
[condwrites]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
[condwritesenforce]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html
[rolechaining]: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html#iam-term-role-chaining
[assumerole]: https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
[iamprincipal]: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html
[iamintro]: https://docs.aws.amazon.com/IAM/latest/UserGuide/introduction.html
[s3pricing]: https://aws.amazon.com/s3/pricing/
[dynamodbpricing]: https://aws.amazon.com/dynamodb/pricing/on-demand/
[leipcerts]: https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
[leprofiles]: https://letsencrypt.org/docs/profiles/
[leratelimits]: https://letsencrypt.org/docs/rate-limits/
[lechallenges]: https://letsencrypt.org/docs/challenge-types/
[caddytls]: https://caddyserver.com/docs/caddyfile/directives/tls
[caddyoptions]: https://caddyserver.com/docs/caddyfile/options
[caddyimage]: https://hub.docker.com/_/caddy
[caddy7399]: https://github.com/caddyserver/caddy/issues/7399
[al2023ssm]: https://docs.aws.amazon.com/linux/al2023/ug/ec2.html#launch-via-aws-cli
[ec2iamroles]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html
[iamconsistency]: https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_general.html#troubleshoot_general_eventual-consistency
[clisg]: https://docs.aws.amazon.com/cli/latest/userguide/cli-services-ec2-sg.html
[ec2addressing]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-instance-addressing.html
[ec2ondemand]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-on-demand-instances.html
[burstable]: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-performance-instances-unlimited-mode-concepts.html
[ec2pricing]: https://aws.amazon.com/ec2/pricing/on-demand/
[vpcpricing]: https://aws.amazon.com/vpc/pricing/
[ebspricing]: https://aws.amazon.com/ebs/pricing/
[composeinstall]: https://docs.docker.com/compose/install/linux/
