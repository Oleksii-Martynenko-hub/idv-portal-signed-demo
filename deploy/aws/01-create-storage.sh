#!/usr/bin/env bash
# Creates the S3 bucket and the DynamoDB table used by the service. The
# bucket's CORS rule depends on the deployed origin and is set by
# set-bucket-cors.sh, which the deploy scripts call.
#
# Required: AWS_REGION, S3_BUCKET. Optional: TABLE_NAME (default idv-portal).
# Credentials come from the usual AWS CLI sources (AWS_PROFILE, env, SSO).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"

export AWS_PAGER=""

# --- S3 bucket -------------------------------------------------------------

if aws s3api head-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Bucket $S3_BUCKET already exists"
else
  # us-east-1 is the only region that rejects a LocationConstraint.
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket \
      --bucket "$S3_BUCKET" \
      --region "$AWS_REGION" \
      --object-ownership BucketOwnerEnforced >/dev/null
  else
    aws s3api create-bucket \
      --bucket "$S3_BUCKET" \
      --region "$AWS_REGION" \
      --object-ownership BucketOwnerEnforced \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  echo "Created bucket $S3_BUCKET in $AWS_REGION"
fi

aws s3api put-public-access-block \
  --bucket "$S3_BUCKET" \
  --region "$AWS_REGION" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
echo "Blocked all public access on $S3_BUCKET"

# New buckets are encrypted with SSE-S3 by default; the policy adds the TLS
# requirement and makes writes under staging/ create-only (If-None-Match: *).
# files/ stays unconditional: S3 refuses CopyObject into a prefix that
# enforces conditional writes, and promotion is a copy.
aws s3api put-bucket-policy \
  --bucket "$S3_BUCKET" \
  --region "$AWS_REGION" \
  --policy "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RequireTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET}",
        "arn:aws:s3:::${S3_BUCKET}/*"
      ],
      "Condition": {
        "Bool": { "aws:SecureTransport": "false" }
      }
    },
    {
      "Sid": "RequireCreateOnlyStagingWrites",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${S3_BUCKET}/staging/*",
      "Condition": {
        "Null": { "s3:if-none-match": "true" }
      }
    }
  ]
}
JSON
)"
echo "Applied bucket policy to $S3_BUCKET (TLS only, create-only writes under staging/)"

# Uploads that are never completed, or whose staged copy could not be
# removed, are left under staging/. The configuration replaces any existing
# one as a whole.
aws s3api put-bucket-lifecycle-configuration \
  --bucket "$S3_BUCKET" \
  --region "$AWS_REGION" \
  --lifecycle-configuration "$(cat <<JSON
{
  "Rules": [
    {
      "ID": "expire-staging",
      "Status": "Enabled",
      "Filter": { "Prefix": "staging/" },
      "Expiration": { "Days": 1 }
    },
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
JSON
)" >/dev/null
echo "Applied lifecycle rules to $S3_BUCKET (staging/ expires after 1 day, incomplete multipart uploads aborted after 1 day)"

# --- DynamoDB table --------------------------------------------------------

if aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "Table $TABLE_NAME already exists"
else
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --region "$AWS_REGION" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "Created table $TABLE_NAME"
fi

aws dynamodb wait table-exists --table-name "$TABLE_NAME" --region "$AWS_REGION"
echo "Table $TABLE_NAME is active"

ttl_status="$(aws dynamodb describe-time-to-live \
  --table-name "$TABLE_NAME" \
  --region "$AWS_REGION" \
  --query 'TimeToLiveDescription.TimeToLiveStatus' \
  --output text)"

case "$ttl_status" in
  ENABLED|ENABLING)
    echo "TTL on attribute ttl is already $ttl_status"
    ;;
  *)
    aws dynamodb update-time-to-live \
      --table-name "$TABLE_NAME" \
      --region "$AWS_REGION" \
      --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null
    echo "Enabled TTL on attribute ttl"
    ;;
esac

echo
echo "Storage ready:"
echo "  S3_BUCKET=$S3_BUCKET"
echo "  DYNAMODB_TABLE=$TABLE_NAME"
echo "Browsers need the bucket's CORS rule for the application's origin;"
echo "ec2/deploy.sh and 03-create-service.sh set it. For local development:"
echo "  ./deploy/aws/set-bucket-cors.sh http://localhost:8080"
