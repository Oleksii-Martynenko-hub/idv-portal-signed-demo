# Deploying to AWS

Documents live in a private S3 bucket; users, sessions and document metadata
live in one DynamoDB table. The scripts in this directory create and remove
everything with the AWS CLI and can be rerun: each one skips resources that
already exist. The service itself runs on one of two paths.

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

Both paths start with the same storage and IAM steps.

## Storage and IAM (both paths)

### Prerequisites

- AWS CLI v2 with working credentials. The scripts read `AWS_REGION` and
  `AWS_PROFILE` from the environment and never override them.
- Node.js 22 or newer; `02-create-iam.sh` uses it to compare policy documents.

### Variables

| Variable      | Required | Default      | Used by                                      |
|---------------|----------|--------------|----------------------------------------------|
| `AWS_REGION`  | yes      | –            | all scripts                                  |
| `AWS_PROFILE` | no       | CLI default  | all scripts                                  |
| `S3_BUCKET`   | yes      | –            | 01, 02, 03, teardown, ec2/launch, ec2/deploy |
| `APP_NAME`    | no       | `idv-portal` | 02, 03, pause, resume, teardown, ec2/*       |
| `TABLE_NAME`  | no       | `idv-portal` | 01, 02, 03, teardown, ec2/launch, ec2/deploy |

Bucket names are global; `idv-portal-<account-id>` is a safe choice.

### Create the storage and the policy

```sh
export AWS_REGION=eu-west-1 AWS_PROFILE=<profile> S3_BUCKET=idv-portal-123456789012

./deploy/aws/01-create-storage.sh
./deploy/aws/02-create-iam.sh
```

1. **`01-create-storage.sh`** – the bucket with all public access blocked and a
   bucket policy that denies requests not made over TLS (S3 applies SSE-S3
   encryption to new buckets by default, so nothing else is needed), and the
   table with `PK`/`SK` string keys, on-demand capacity and TTL on the `ttl`
   attribute. Waits until the table is active.
2. **`02-create-iam.sh`** – the `<APP_NAME>-app` policy from
   `iam/app-policy.json` with the bucket and table ARNs substituted, and the
   `<APP_NAME>-instance` role trusted by `tasks.apprunner.amazonaws.com`. The
   policy allows `PutObject`, `GetObject` and `DeleteObject` under `users/*`
   and the six DynamoDB actions the service uses; nothing else, and no
   `ListBucket`. When the policy already exists and its document differs
   (another bucket or table, or a change to `app-policy.json`), the script
   publishes the rendered document as the new default version, dropping the
   oldest version first if IAM's limit of five is reached. The EC2 path
   attaches the same policy to its own role and ignores the App Runner role.

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

**`03-create-service.sh`** creates an auto scaling configuration named
`<APP_NAME>` with min 1 / max 1 and 100 concurrent requests per instance
(App Runner's default), then the service: 0.25 vCPU / 0.5 GB, the instance
role, HTTP health check on `/healthz`, automatic deployments off, runtime
variables `NODE_ENV`, `AWS_REGION`, `S3_BUCKET` and `DYNAMODB_TABLE`. It
polls until the service is `RUNNING` and prints the URL. The first build
and deployment takes several minutes.

IAM is eventually consistent: if the script reports the instance role as
invalid right after `02-create-iam.sh`, wait a few seconds and run it again.

#### Memory, upload size and concurrency

Every upload is held in memory up to `MAX_UPLOAD_MB` (default 10 MB). Two
settings bound how many are in flight:

- `--max-concurrency` on the auto scaling configuration (100 in
  `03-create-service.sh`, App Runner's default) is the number of requests App
  Runner routes to an instance at once; above it, requests queue or go to
  another instance, and with max size 1 there is none.
- `MAX_CONCURRENT_UPLOADS` (default 100, set on the service like the other
  runtime variables) is the number of uploads the process accepts at once;
  above it, it answers `503 server_busy` instead of allocating another buffer.

On one 0.25 vCPU / 0.5 GB instance with uploads buffered up to `MAX_UPLOAD_MB`
each, memory, not the request cap, is the practical bound at this size. Lower
`MAX_CONCURRENT_UPLOADS` or raise the instance memory to match the upload
volume you expect, and keep `MAX_CONCURRENT_UPLOADS` at or below
`--max-concurrency`.

Changing `--max-concurrency` on a running service means creating a new
revision of the configuration (`create-auto-scaling-configuration` with the
same name) and pointing the service at it with `update-service
--auto-scaling-configuration-arn`.

#### Build configuration: API values and `apprunner.yaml`

App Runner reads a source service's build and run settings from exactly one
place: `apprunner.yaml` in the repository (`ConfigurationSource: REPOSITORY`)
or the values passed in the API call (`ConfigurationSource: API`). In
repository mode the API values, including runtime environment variables, are
ignored ([CodeConfiguration][codeconfig]). The bucket, table and region differ
per deployment and do not belong in the repository, so the script configures
the service through the API: build `npm ci && npm run build && npm prune
--omit=dev`, start `npm start`, port 8080. `apprunner.yaml` at the repository
root carries the same steps for a service created from the console with
**Use a configuration file**; in that mode the three variables have to be
added to its `run.env` section or referenced from Parameter Store.

### Redeploy

Automatic deployments are off, so pushing to the branch changes nothing until
a deployment is started. App Runner then builds the latest commit of the
configured branch and replaces the running instance.

```sh
service_arn=$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='idv-portal'].ServiceArn | [0]" --output text)
aws apprunner start-deployment --region "$AWS_REGION" --service-arn "$service_arn"
```

Progress shows in the console event log, or `describe-service` returns
`Service.Status` to `RUNNING`. Runtime environment variables are part of the
service configuration; change them in the console (Configuration tab) or with
`aws apprunner update-service`.

### Platform limits

| Limit | Value | Effect on this service |
|---|---|---|
| Request timeout | 120 seconds in total, including reading the request body and writing the response | An upload or download that does not complete within 120 s is cut off. Uploads are capped at `MAX_UPLOAD_MB` (default 10 MB). |
| Request body size | Not documented by App Runner | The service enforces its own limit: `411` without `Content-Length`, `413` above `MAX_UPLOAD_MB` plus 64 KiB. |
| HTTP | HTTP/1.0 and 1.1 to the container; TLS terminated by App Runner; plain HTTP redirected to HTTPS | `NODE_ENV=production` turns on `Secure` cookies and `trust proxy`. |
| Port | App Runner injects `PORT` with the configured port (8080) and reserves that variable name | The service listens on `PORT`, default 8080. |
| Instance startup | Must be listening and healthy within 5 minutes | Startup takes seconds. |
| Ephemeral storage | 3 GB per instance, shared with the container image; not preserved across pause/resume or instance replacement | Nothing is written to disk; uploads are buffered in memory and sent to S3. |
| Instance size | 0.25 vCPU / 0.5 GB, the smallest supported combination | Memory bounds the number of simultaneous uploads, each buffered up to `MAX_UPLOAD_MB`; see [Memory, upload size and concurrency](#memory-upload-size-and-concurrency). |
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
  are billed separately by those services.

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
`RUNNING`. Pausing does not touch the bucket or the table.

### Teardown

```sh
./deploy/aws/teardown.sh
```

The script lists what it is about to delete and asks you to type the
application name. It then deletes the service (waiting until it is gone),
empties and deletes the bucket, deletes the table and the role, detaches the
policy from every role that still has it (the EC2 role included) and deletes
it with its older versions, and deletes all revisions of the auto scaling
configuration, which is only possible once no service uses it. The GitHub connection is left
in place; remove it under **Connected accounts** in the console or with
`aws apprunner delete-connection` if nothing else uses it.

### Alternative: deploy the container image from ECR

The source path needs no Docker locally. To build the image yourself, or to
run the service elsewhere, use the `Dockerfile` at the repository root.

1. Build for `linux/amd64` and push to a private ECR repository:

   ```sh
   account_id=$(aws sts get-caller-identity --query Account --output text)
   registry="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
   tag="$(git rev-parse --short HEAD)"

   aws ecr create-repository --region "$AWS_REGION" --repository-name idv-portal
   aws ecr get-login-password --region "$AWS_REGION" \
     | docker login --username AWS --password-stdin "$registry"
   docker buildx build --platform linux/amd64 -t "${registry}/idv-portal:${tag}" --push .
   ```

2. Create the access role App Runner uses to pull from ECR. It is trusted by
   `build.apprunner.amazonaws.com` (not `tasks.`) and uses the AWS managed
   policy:

   ```sh
   aws iam create-role --role-name idv-portal-ecr-access \
     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
   aws iam attach-role-policy --role-name idv-portal-ecr-access \
     --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
   ```

3. Create the service from the image. Storage, the instance role and the auto
   scaling configuration are the same as on the source path (run steps 1 and 2
   above first); only `SourceConfiguration` differs:

   ```json
   {
     "ServiceName": "idv-portal",
     "SourceConfiguration": {
       "AuthenticationConfiguration": {
         "AccessRoleArn": "arn:aws:iam::<account-id>:role/idv-portal-ecr-access"
       },
       "AutoDeploymentsEnabled": false,
       "ImageRepository": {
         "ImageIdentifier": "<account-id>.dkr.ecr.<region>.amazonaws.com/idv-portal:<tag>",
         "ImageRepositoryType": "ECR",
         "ImageConfiguration": {
           "Port": "8080",
           "RuntimeEnvironmentVariables": {
             "NODE_ENV": "production",
             "AWS_REGION": "<region>",
             "S3_BUCKET": "<bucket>",
             "DYNAMODB_TABLE": "idv-portal"
           }
         }
       }
     },
     "InstanceConfiguration": {
       "Cpu": "0.25 vCPU",
       "Memory": "0.5 GB",
       "InstanceRoleArn": "arn:aws:iam::<account-id>:role/idv-portal-instance"
     },
     "HealthCheckConfiguration": {
       "Protocol": "HTTP",
       "Path": "/healthz",
       "Interval": 10,
       "Timeout": 5,
       "HealthyThreshold": 1,
       "UnhealthyThreshold": 5
     },
     "AutoScalingConfigurationArn": "arn:aws:apprunner:<region>:<account-id>:autoscalingconfiguration/idv-portal"
   }
   ```

   ```sh
   aws apprunner create-service --region "$AWS_REGION" --cli-input-json file://service.json
   ```

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
  instance role.
- A default VPC in the region (`aws ec2 create-default-vpc` recreates one).
- `01-create-storage.sh` and `02-create-iam.sh` already run, so the bucket,
  the table and the `<APP_NAME>-app` policy exist.

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

**`launch.sh`** creates, or reuses by name, each of the following, then runs
`deploy.sh`:

1. The role `<APP_NAME>-ec2` trusted by `ec2.amazonaws.com`
   (`iam/ec2-instance-trust.json`) with the `<APP_NAME>-app` policy attached,
   and the instance profile `<APP_NAME>-ec2` holding it.
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
`docker` group, installs the Docker Compose plugin from its GitHub release
(AL2023 does not package it; the download is checked against the published
SHA-256), adds a 1 GiB swap file so that `npm ci` and `tsc` survive the
instance's 1 GiB of memory during image builds, and creates `/opt/idv-portal`
owned by `ec2-user`.

If an instance tagged `Name=<APP_NAME>` is already running, `launch.sh` skips
straight to the deployment; a stopped one is started first.

**`deploy.sh`** finds the running instance by tag (or takes `INSTANCE_IP`),
`rsync`s the files tracked by git (committed or staged; untracked files are
never sent) to `/opt/idv-portal`, deleting anything there that is no longer
tracked except `.env`, writes `/opt/idv-portal/.env`:

```
NODE_ENV=production
PORT=8080
AWS_REGION=<region>
S3_BUCKET=<bucket>
DYNAMODB_TABLE=<table>
TRUST_PROXY=1
PUBLIC_HOST=<public IP, or PUBLIC_HOST if set>
```

then runs `docker compose up -d --build` over SSH, polls
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
  credentials come from the instance role through IMDSv2. The container is
  limited to 768 MiB of memory (`mem_limit`); if it exceeds that, Docker
  restarts it, and Caddy and SSH stay up.
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
ssh -i ~/.ssh/idv-portal-ec2.pem ec2-user@<public-ip>
cd /opt/idv-portal
docker compose ps
docker compose logs -f               # add a service name (app, caddy) for one of them
docker stats --no-stream
sudo tail -n 50 /var/log/cloud-init-output.log   # first-boot setup
```

### Cost

EC2 bills on the dimensions below; rates depend on the region, so read the
pricing pages ([On-Demand][ec2pricing], [public IPv4][vpcpricing]) rather
than this file.

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
  are billed separately by those services.

### Stop, start and teardown

To pause the cost of the instance, stop it; the volume and the configuration
on it are kept:

```sh
instance_id=$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters Name=tag:Name,Values=idv-portal Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId | [0]' --output text)
aws ec2 stop-instances --region "$AWS_REGION" --instance-ids "$instance_id"
```

EC2 releases the public IPv4 address when the instance stops and assigns a
new one when it starts, so bring it back with `./deploy/aws/ec2/launch.sh`,
which starts the instance and redeploys with the new address.

```sh
./deploy/aws/ec2/teardown.sh
./deploy/aws/teardown.sh
```

`ec2/teardown.sh` asks you to type the application name, then terminates the
instance and waits for it, deletes the security group (retrying until the
instance's network interface is gone), the key pair and the local private
key, the instance profile and the role, and drops the instance's host key
from `~/.ssh/known_hosts`. The bucket, table and application policy are left
for `deploy/aws/teardown.sh`, which skips the App Runner service and auto
scaling configuration when there are none.

### Troubleshooting

- **No certificate, or the TLS handshake fails.** Let's Encrypt validates an
  IP address with the HTTP-01 or TLS-ALPN-01 challenge (DNS-01 cannot), so
  ports 80 and 443 must be reachable from the internet, not only from your
  network. `launch.sh` opens both in the security group; check that nothing
  else (a network ACL, a changed rule) is in the way, then
  `docker compose logs caddy` on the instance.
- **The public IP changed after a stop/start.** The old address is gone and
  `.env` still names it. Run `./deploy/aws/ec2/deploy.sh` (or `launch.sh`,
  which does the same after starting the instance): it writes the new
  `PUBLIC_HOST` and Caddy obtains a certificate for it.
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

## References

- [AWS App Runner availability change][availability]
- [Configuration file reference][configref] (`apprunner.yaml` keys)
- [Node.js platform][nodejs] and [Node.js runtime releases][nodejsreleases]
- [Developing application code for App Runner][develop] (request timeout, `PORT`, ephemeral storage, startup time)
- [Architecture and concepts][architecture] (instance sizes, quotas)
- [Referencing environment variables][envvars] (`PORT` is reserved)
- [How App Runner works with IAM][iam] (instance role and access role trust policies)
- [Managing connections][connections]
- [Deploying a new application version][deploy] (manual vs automatic deployments)
- [Configuring health checks][healthcheck]
- [Deleting a service][delete] (pause vs delete)
- [CodeConfiguration][codeconfig] (`REPOSITORY` vs `API`)
- [create-service][createservice], [create-auto-scaling-configuration][createasc], [pause-service][pause], [resume-service][resume], [start-deployment][startdeployment]
- [App Runner pricing][pricing]
- [S3 default encryption FAQ][s3encryption] and [bucket policy examples][s3policies] (TLS-only policy)
- [Let's Encrypt: short-lived and IP address certificates][leipcerts], [certificate profiles][leprofiles], [rate limits][leratelimits], [challenge types][lechallenges]
- [Caddy `tls` directive][caddytls] (`issuer acme`, `profile`), [global options][caddyoptions] (`default_sni`), [Caddy image][caddyimage]
- [Launching AL2023 with the SSM parameter][al2023ssm]
- [IAM roles for Amazon EC2][ec2iamroles] (instance profiles), [IAM eventual consistency][iamconsistency]
- [Security groups in the AWS CLI][clisg] (`checkip.amazonaws.com`)
- [EC2 instance IP addressing][ec2addressing] (public IPv4 released on stop)
- [On-Demand Instances][ec2ondemand] (per-second billing), [unlimited mode for burstable instances][burstable]
- [EC2 On-Demand pricing][ec2pricing], [VPC pricing][vpcpricing] (public IPv4)
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
[composeinstall]: https://docs.docker.com/compose/install/linux/
