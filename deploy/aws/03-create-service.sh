#!/usr/bin/env bash
# Creates the App Runner auto scaling configuration and the service from the
# GitHub repository, waits for the first deployment, then allows the service
# URL in the bucket's CORS rule and prints the URL. Rerun against a service
# that already exists, it sets the CORS rule once the service is RUNNING with
# this deployment's bucket and a signer role.
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
account_id="$(aws sts get-caller-identity --query Account --output text)"
instance_role_arn="arn:aws:iam::${account_id}:role/${APP_NAME}-instance"
signer_role_arn="arn:aws:iam::${account_id}:role/${APP_NAME}-signer"

if ! aws iam get-role --role-name "${APP_NAME}-signer" >/dev/null 2>&1; then
  echo "Role $signer_role_arn not found; run 02-create-iam.sh first." >&2
  exit 1
fi

# AWS documents update-service and the console's Rebuild, not
# start-deployment, as the way to rebuild a service whose first deployment
# failed. Deleting only the service keeps the bucket, table and roles, which
# teardown.sh would delete as well.
print_create_failed_hint() {
  echo "Its first deployment failed; the service event log in the console says why." >&2
  echo "Fix the cause and push $BRANCH, then rebuild the service with" >&2
  echo "aws apprunner update-service (same values) or Rebuild in the console, and" >&2
  echo "rerun this script once it is RUNNING. Or delete just the service and rerun:" >&2
  echo "  aws apprunner delete-service --region $AWS_REGION --service-arn $1" >&2
}

# --- Auto scaling configuration (single instance) --------------------------

# Requests one instance handles at a time (App Runner's default). Files go
# between the browser and S3 directly, so every request to the service is a
# small JSON call.
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

# A first run that was interrupted or timed out leaves a service whose URL was
# never allowed in the bucket's CORS rule, so a rerun finishes that step.
if [ -n "$existing_arn" ] && [ "$existing_arn" != "None" ]; then
  existing_status="$(aws apprunner describe-service \
    --region "$AWS_REGION" \
    --service-arn "$existing_arn" \
    --query 'Service.Status' \
    --output text)"
  existing_url="$(aws apprunner describe-service \
    --region "$AWS_REGION" \
    --service-arn "$existing_arn" \
    --query 'Service.ServiceUrl' \
    --output text)"
  case "$existing_status" in
    RUNNING)
      # The name alone does not tie the service to this deployment: with
      # APP_NAME left at its default it can be another deployment's service,
      # and a service created by an earlier release runs without
      # S3_SIGNER_ROLE_ARN. Only a service that uses this bucket and a signer
      # role gets the bucket's CORS rule, so a rerun never points the rule at
      # an origin that does not upload to it. A source service keeps its
      # variables under CodeRepository, an image service under ImageRepository.
      env_query='(Service.SourceConfiguration.CodeRepository.CodeConfiguration.CodeConfigurationValues'
      env_query+=' || Service.SourceConfiguration.ImageRepository.ImageConfiguration)'
      env_query+='.RuntimeEnvironmentVariables.[S3_BUCKET, S3_SIGNER_ROLE_ARN]'
      service_vars="$(aws apprunner describe-service \
        --region "$AWS_REGION" \
        --service-arn "$existing_arn" \
        --query "$env_query" \
        --output text)"
      read -r service_bucket service_signer <<<"$service_vars"
      # The CLI prints None for a variable the service does not have.
      [ "$service_bucket" != "None" ] || service_bucket=""
      [ "$service_signer" != "None" ] || service_signer=""
      if [ "$service_bucket" != "$S3_BUCKET" ] || [ -z "$service_signer" ]; then
        echo "Service $APP_NAME is running with S3_BUCKET=${service_bucket:-(unset)} and" >&2
        echo "S3_SIGNER_ROLE_ARN=${service_signer:-(unset)}: $existing_arn" >&2
        echo "It belongs to another deployment or an earlier release, so the CORS rule of" >&2
        echo "bucket $S3_BUCKET was left as it is. See \"Running beside another deployment\"" >&2
        echo "in deploy/aws/README.md." >&2
        exit 1
      fi
      "$script_dir/set-bucket-cors.sh" "https://${existing_url}"
      echo
      echo "Service $APP_NAME already exists and is running:"
      echo "  ARN: $existing_arn"
      echo "  URL: https://${existing_url}"
      echo "Use start-deployment to redeploy, or teardown.sh to remove it."
      exit 0
      ;;
    OPERATION_IN_PROGRESS)
      echo "Service $APP_NAME already exists and its deployment is still running: $existing_arn" >&2
      echo "Once it is RUNNING, rerun this script, or allow its URL in the bucket's CORS rule with:" >&2
      echo "  ./deploy/aws/set-bucket-cors.sh https://${existing_url}" >&2
      exit 1
      ;;
    CREATE_FAILED)
      echo "Service $APP_NAME already exists in state CREATE_FAILED: $existing_arn" >&2
      print_create_failed_hint "$existing_arn"
      exit 1
      ;;
    PAUSED)
      echo "Service $APP_NAME already exists and is paused: $existing_arn" >&2
      echo "Resume it with ./deploy/aws/resume.sh, then rerun this script once it is RUNNING." >&2
      exit 1
      ;;
    DELETE_FAILED)
      echo "Service $APP_NAME already exists in state DELETE_FAILED: $existing_arn" >&2
      echo "Retry the deletion, then rerun this script once the service is gone:" >&2
      echo "  aws apprunner delete-service --region $AWS_REGION --service-arn $existing_arn" >&2
      exit 1
      ;;
    *)
      echo "Service $APP_NAME already exists in state $existing_status: $existing_arn" >&2
      echo "Use start-deployment to redeploy, or teardown.sh to remove it." >&2
      echo "Once it is RUNNING, allow its URL in the bucket's CORS rule with:" >&2
      echo "  ./deploy/aws/set-bucket-cors.sh https://${existing_url}" >&2
      exit 1
      ;;
  esac
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
            "DYNAMODB_TABLE": "${TABLE_NAME}",
            "S3_SIGNER_ROLE_ARN": "${signer_role_arn}"
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

created="$(aws apprunner create-service \
  --region "$AWS_REGION" \
  --cli-input-json "file://$input_file" \
  --query '[Service.ServiceArn, Service.ServiceUrl]' \
  --output text)"
read -r service_arn service_url <<<"$created"
# The URL is assigned at creation, so an interrupted wait still leaves the
# operator what the CORS rule needs.
echo "Created service $service_arn"
echo "  URL: https://${service_url}"
echo "If the wait is interrupted, rerun this script once the service is RUNNING, or run:"
echo "  ./deploy/aws/set-bucket-cors.sh https://${service_url}"
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
    CREATE_FAILED)
      echo "Service $service_arn ended in state CREATE_FAILED." >&2
      print_create_failed_hint "$service_arn"
      exit 1
      ;;
    *)
      echo "Service ended in state $status; check the service event log in the console." >&2
      exit 1
      ;;
  esac
done

"$script_dir/set-bucket-cors.sh" "https://${service_url}"

echo
echo "Service is running:"
echo "  ARN: $service_arn"
echo "  URL: https://${service_url}"
echo "Redeployments, pause and resume keep this URL, so the bucket's CORS rule"
echo "stays valid. If something else replaces it, restore it with:"
echo "  ./deploy/aws/set-bucket-cors.sh https://${service_url}"
