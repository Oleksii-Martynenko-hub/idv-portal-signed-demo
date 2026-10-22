#!/usr/bin/env bash
# Creates the App Runner auto scaling configuration and the service from the
# GitHub repository, then waits for the first deployment and prints the URL.
#
# Required: AWS_REGION, S3_BUCKET, CONNECTION_ARN, REPO_URL.
# Optional: APP_NAME (default idv-portal), TABLE_NAME (default idv-portal),
# BRANCH (default main).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${CONNECTION_ARN:?CONNECTION_ARN is required (ARN of the GitHub connection)}"
: "${REPO_URL:?REPO_URL is required (https://github.com/<owner>/<repo>)}"
APP_NAME="${APP_NAME:-idv-portal}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"
BRANCH="${BRANCH:-main}"

export AWS_PAGER=""

account_id="$(aws sts get-caller-identity --query Account --output text)"
instance_role_arn="arn:aws:iam::${account_id}:role/${APP_NAME}-instance"

# --- Auto scaling configuration (single instance) --------------------------

# Requests one instance handles at a time (App Runner's default). Uploads are
# held in memory, so on a 0.5 GB instance memory, not this cap, bounds them;
# see the README.
MAX_CONCURRENCY=100

asc_arn="$(aws apprunner list-auto-scaling-configurations \
  --region "$AWS_REGION" \
  --auto-scaling-configuration-name "$APP_NAME" \
  --latest-only \
  --query "AutoScalingConfigurationSummaryList[?Status=='ACTIVE'] | [0].AutoScalingConfigurationArn" \
  --output text)"

if [ -n "$asc_arn" ] && [ "$asc_arn" != "None" ]; then
  current_concurrency="$(aws apprunner describe-auto-scaling-configuration \
    --region "$AWS_REGION" \
    --auto-scaling-configuration-arn "$asc_arn" \
    --query 'AutoScalingConfiguration.MaxConcurrency' \
    --output text)"
  if [ "$current_concurrency" != "$MAX_CONCURRENCY" ]; then
    asc_arn=""
  fi
fi

if [ -z "$asc_arn" ] || [ "$asc_arn" = "None" ]; then
  asc_arn="$(aws apprunner create-auto-scaling-configuration \
    --region "$AWS_REGION" \
    --auto-scaling-configuration-name "$APP_NAME" \
    --min-size 1 \
    --max-size 1 \
    --max-concurrency "$MAX_CONCURRENCY" \
    --query 'AutoScalingConfiguration.AutoScalingConfigurationArn' \
    --output text)"
  echo "Created auto scaling configuration $asc_arn"
else
  echo "Using auto scaling configuration $asc_arn"
fi

# --- Service ---------------------------------------------------------------

existing_arn="$(aws apprunner list-services \
  --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${APP_NAME}'].ServiceArn | [0]" \
  --output text)"

if [ -n "$existing_arn" ] && [ "$existing_arn" != "None" ]; then
  echo "Service $APP_NAME already exists: $existing_arn" >&2
  echo "Use start-deployment to redeploy, or teardown.sh to remove it." >&2
  exit 1
fi

# App Runner reads either apprunner.yaml or the values below, never both.
# Deployment-specific variables have to travel with the service, so the
# service is configured through the API; apprunner.yaml carries the same
# build and run steps for configuration-file mode.
input_file="$(mktemp)"
trap 'rm -f "$input_file"' EXIT
cat > "$input_file" <<JSON
{
  "ServiceName": "${APP_NAME}",
  "SourceConfiguration": {
    "AuthenticationConfiguration": {
      "ConnectionArn": "${CONNECTION_ARN}"
    },
    "AutoDeploymentsEnabled": false,
    "CodeRepository": {
      "RepositoryUrl": "${REPO_URL}",
      "SourceCodeVersion": {
        "Type": "BRANCH",
        "Value": "${BRANCH}"
      },
      "CodeConfiguration": {
        "ConfigurationSource": "API",
        "CodeConfigurationValues": {
          "Runtime": "NODEJS_22",
          "BuildCommand": "npm ci && npm run build && npm prune --omit=dev",
          "StartCommand": "npm start",
          "Port": "8080",
          "RuntimeEnvironmentVariables": {
            "NODE_ENV": "production",
            "AWS_REGION": "${AWS_REGION}",
            "S3_BUCKET": "${S3_BUCKET}",
            "DYNAMODB_TABLE": "${TABLE_NAME}"
          }
        }
      }
    }
  },
  "InstanceConfiguration": {
    "Cpu": "0.25 vCPU",
    "Memory": "0.5 GB",
    "InstanceRoleArn": "${instance_role_arn}"
  },
  "HealthCheckConfiguration": {
    "Protocol": "HTTP",
    "Path": "/healthz",
    "Interval": 10,
    "Timeout": 5,
    "HealthyThreshold": 1,
    "UnhealthyThreshold": 5
  },
  "AutoScalingConfigurationArn": "${asc_arn}"
}
JSON

service_arn="$(aws apprunner create-service \
  --region "$AWS_REGION" \
  --cli-input-json "file://$input_file" \
  --query 'Service.ServiceArn' \
  --output text)"
echo "Created service $service_arn"
echo "Waiting for the first build and deployment (usually several minutes)..."

deadline=$(( $(date +%s) + 30 * 60 ))
while :; do
  status="$(aws apprunner describe-service \
    --region "$AWS_REGION" \
    --service-arn "$service_arn" \
    --query 'Service.Status' \
    --output text)"
  case "$status" in
    RUNNING)
      break
      ;;
    OPERATION_IN_PROGRESS)
      if [ "$(date +%s)" -ge "$deadline" ]; then
        echo "Timed out waiting for $service_arn; check the service event log in the console." >&2
        exit 1
      fi
      sleep 15
      ;;
    *)
      echo "Service ended in state $status; check the service event log in the console." >&2
      exit 1
      ;;
  esac
done

service_url="$(aws apprunner describe-service \
  --region "$AWS_REGION" \
  --service-arn "$service_arn" \
  --query 'Service.ServiceUrl' \
  --output text)"

echo
echo "Service is running:"
echo "  ARN: $service_arn"
echo "  URL: https://${service_url}"
