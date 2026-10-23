#!/usr/bin/env bash
# Sets the bucket's CORS rule so that pages served from one origin can upload
# to and read from the bucket with presigned URLs. The rule replaces the
# bucket's whole CORS configuration, so the bucket serves one origin at a
# time.
#
# Usage: set-bucket-cors.sh <origin>, e.g. https://203.0.113.10 or
# http://localhost:8080.
# Required: AWS_REGION, S3_BUCKET, and the origin as the argument or in
# APP_ORIGIN. Set AWS_ENDPOINT_URL_S3 to target a local S3 such as LocalStack.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
origin="${1:-${APP_ORIGIN:-}}"

export AWS_PAGER=""

if [ -z "$origin" ]; then
  echo "Usage: $0 <origin> (or set APP_ORIGIN), e.g. https://203.0.113.10" >&2
  exit 1
fi

# Browsers send the Origin header in lower case, without a trailing slash and
# without the scheme's default port; S3 compares it with AllowedOrigins as is.
origin="$(printf '%s' "$origin" | tr '[:upper:]' '[:lower:]')"
origin="${origin%/}"
case "$origin" in
  https://*:443) origin="${origin%:443}" ;;
  http://*:80) origin="${origin%:80}" ;;
esac

https_origin='^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'
local_origin='^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$'
if ! [[ "$origin" =~ $https_origin || "$origin" =~ $local_origin ]]; then
  echo "Origin '$origin' must be https://<host>[:port], or http://localhost[:port] or http://127.0.0.1[:port], with no path." >&2
  exit 1
fi

# Content-Type, Cache-Control, Content-Disposition, If-None-Match and the
# checksum are signed into each upload URL, so the browser sends all five
# and asks for them in the preflight.
aws s3api put-bucket-cors \
  --bucket "$S3_BUCKET" \
  --region "$AWS_REGION" \
  --cors-configuration "$(cat <<JSON
{
  "CORSRules": [
    {
      "ID": "app-origin",
      "AllowedOrigins": ["${origin}"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": [
        "content-type",
        "cache-control",
        "content-disposition",
        "if-none-match",
        "x-amz-checksum-sha256"
      ],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 600
    }
  ]
}
JSON
)"
echo "Bucket $S3_BUCKET accepts browser uploads and reads from $origin"
