#!/usr/bin/env bash
# Deletes everything the 01-03 scripts created: the App Runner service, the
# bucket and its objects, the table, the IAM role and policy, and the auto
# scaling configuration. The GitHub connection is left in place because it
# can be shared by other services.
#
# Required: AWS_REGION, S3_BUCKET. Optional: APP_NAME (default idv-portal),
# TABLE_NAME (default idv-portal).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
APP_NAME="${APP_NAME:-idv-portal}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"

export AWS_PAGER=""

account_id="$(aws sts get-caller-identity --query Account --output text)"
policy_name="${APP_NAME}-app"
role_name="${APP_NAME}-instance"
policy_arn="arn:aws:iam::${account_id}:policy/${policy_name}"
asc_arn="arn:aws:apprunner:${AWS_REGION}:${account_id}:autoscalingconfiguration/${APP_NAME}"

cat <<EOT
This permanently deletes, in $AWS_REGION (account $account_id):
  - App Runner service        $APP_NAME
  - S3 bucket and all objects $S3_BUCKET
  - DynamoDB table            $TABLE_NAME
  - IAM role and policy       $role_name, $policy_name
  - auto scaling configuration $APP_NAME
EOT
read -r -p "Type the application name ($APP_NAME) to continue: " answer
if [ "$answer" != "$APP_NAME" ]; then
  echo "Aborted"
  exit 1
fi

# --- App Runner service ----------------------------------------------------

service_arn="$(aws apprunner list-services \
  --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${APP_NAME}'].ServiceArn | [0]" \
  --output text)"

if [ -n "$service_arn" ] && [ "$service_arn" != "None" ]; then
  aws apprunner delete-service --region "$AWS_REGION" --service-arn "$service_arn" >/dev/null
  echo "Deleting service $service_arn ..."
  while :; do
    status="$(aws apprunner describe-service \
      --region "$AWS_REGION" \
      --service-arn "$service_arn" \
      --query 'Service.Status' \
      --output text 2>/dev/null || echo DELETED)"
    case "$status" in
      DELETED) break ;;
      DELETE_FAILED)
        echo "Service deletion failed; retry the deletion from the console or rerun this script." >&2
        exit 1
        ;;
      *) sleep 10 ;;
    esac
  done
  echo "Deleted service $APP_NAME"
else
  echo "No service named $APP_NAME"
fi

# --- S3 bucket -------------------------------------------------------------

if aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws s3 rm "s3://${S3_BUCKET}" --recursive --region "$AWS_REGION" --only-show-errors
  aws s3api delete-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION"
  echo "Deleted bucket $S3_BUCKET"
else
  echo "No bucket named $S3_BUCKET"
fi

# --- DynamoDB table --------------------------------------------------------

if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws dynamodb delete-table --table-name "$TABLE_NAME" --region "$AWS_REGION" >/dev/null
  aws dynamodb wait table-not-exists --table-name "$TABLE_NAME" --region "$AWS_REGION"
  echo "Deleted table $TABLE_NAME"
else
  echo "No table named $TABLE_NAME"
fi

# --- IAM -------------------------------------------------------------------

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
    aws iam detach-role-policy --role-name "$role_name" --policy-arn "$policy_arn" || true
  fi
  aws iam delete-role --role-name "$role_name"
  echo "Deleted role $role_name"
else
  echo "No role named $role_name"
fi

if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
  # ec2/launch.sh attaches the policy to its own role as well.
  for attached in $(aws iam list-entities-for-policy \
      --policy-arn "$policy_arn" \
      --entity-filter Role \
      --query 'PolicyRoles[].RoleName' \
      --output text); do
    aws iam detach-role-policy --role-name "$attached" --policy-arn "$policy_arn"
    echo "Detached $policy_name from $attached"
  done
  # delete-policy refuses a policy that still has versions besides the default.
  for version in $(aws iam list-policy-versions \
      --policy-arn "$policy_arn" \
      --query 'Versions[?IsDefaultVersion==`false`].VersionId' \
      --output text); do
    aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$version"
  done
  aws iam delete-policy --policy-arn "$policy_arn"
  echo "Deleted policy $policy_name"
else
  echo "No policy named $policy_name"
fi

# --- Auto scaling configuration (must come after the service is gone) ------

asc_count="$(aws apprunner list-auto-scaling-configurations \
  --region "$AWS_REGION" \
  --auto-scaling-configuration-name "$APP_NAME" \
  --no-latest-only \
  --query "length(AutoScalingConfigurationSummaryList[?Status=='ACTIVE'])" \
  --output text)"

if [ "$asc_count" != "0" ]; then
  aws apprunner delete-auto-scaling-configuration \
    --region "$AWS_REGION" \
    --auto-scaling-configuration-arn "$asc_arn" \
    --delete-all-revisions >/dev/null
  echo "Deleted auto scaling configuration $APP_NAME"
else
  echo "No auto scaling configuration named $APP_NAME"
fi

echo
echo "Teardown complete."
