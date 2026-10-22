#!/usr/bin/env bash
# Resumes a paused App Runner service on new compute; the URL does not change.
#
# Required: AWS_REGION. Optional: APP_NAME (default idv-portal).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
APP_NAME="${APP_NAME:-idv-portal}"

export AWS_PAGER=""

service_arn="$(aws apprunner list-services \
  --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${APP_NAME}'].ServiceArn | [0]" \
  --output text)"

if [ -z "$service_arn" ] || [ "$service_arn" = "None" ]; then
  echo "No App Runner service named $APP_NAME in $AWS_REGION" >&2
  exit 1
fi

aws apprunner resume-service --region "$AWS_REGION" --service-arn "$service_arn" >/dev/null
echo "Resume requested for $service_arn"
echo "Status becomes RUNNING once the operation completes:"
echo "  aws apprunner describe-service --region $AWS_REGION --service-arn $service_arn --query Service.Status"
