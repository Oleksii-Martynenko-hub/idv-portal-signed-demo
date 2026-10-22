#!/usr/bin/env bash
# Creates the application IAM policy and the App Runner instance role.
#
# Required: AWS_REGION, S3_BUCKET. Optional: APP_NAME (default idv-portal),
# TABLE_NAME (default idv-portal).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
APP_NAME="${APP_NAME:-idv-portal}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"

export AWS_PAGER=""

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
account_id="$(aws sts get-caller-identity --query Account --output text)"

policy_name="${APP_NAME}-app"
role_name="${APP_NAME}-instance"
policy_arn="arn:aws:iam::${account_id}:policy/${policy_name}"
role_arn="arn:aws:iam::${account_id}:role/${role_name}"
table_arn="arn:aws:dynamodb:${AWS_REGION}:${account_id}:table/${TABLE_NAME}"

policy_file="$(mktemp)"
current_file="$(mktemp)"
trap 'rm -f "$policy_file" "$current_file"' EXIT
sed \
  -e "s|__S3_BUCKET__|${S3_BUCKET}|g" \
  -e "s|__TABLE_ARN__|${table_arn}|g" \
  "$script_dir/iam/app-policy.json" > "$policy_file"

# True when two policy documents match, whatever their key order and spacing.
same_policy() {
  node -e '
    const fs = require("node:fs");
    const sorted = (value) =>
      Array.isArray(value) ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
          : value;
    const [a, b] = process.argv.slice(1).map((file) => JSON.stringify(sorted(JSON.parse(fs.readFileSync(file, "utf8")))));
    process.exit(a === b ? 0 : 1);
  ' "$1" "$2"
}

if aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
  default_version="$(aws iam get-policy \
    --policy-arn "$policy_arn" \
    --query 'Policy.DefaultVersionId' \
    --output text)"
  aws iam get-policy-version \
    --policy-arn "$policy_arn" \
    --version-id "$default_version" \
    --query 'PolicyVersion.Document' \
    --output json > "$current_file"

  if same_policy "$policy_file" "$current_file"; then
    echo "Policy $policy_arn already grants bucket $S3_BUCKET and table $TABLE_NAME"
  else
    # A managed policy keeps at most five versions.
    version_count="$(aws iam list-policy-versions \
      --policy-arn "$policy_arn" \
      --query 'length(Versions)' \
      --output text)"
    if [ "$version_count" -ge 5 ]; then
      oldest_version="$(aws iam list-policy-versions \
        --policy-arn "$policy_arn" \
        --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' \
        --output text)"
      aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$oldest_version"
    fi
    aws iam create-policy-version \
      --policy-arn "$policy_arn" \
      --policy-document "file://$policy_file" \
      --set-as-default >/dev/null
    echo "Updated policy $policy_arn to grant bucket $S3_BUCKET and table $TABLE_NAME"
  fi
else
  aws iam create-policy \
    --policy-name "$policy_name" \
    --policy-document "file://$policy_file" >/dev/null
  echo "Created policy $policy_arn"
fi

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  echo "Role $role_arn already exists"
else
  aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document "file://$script_dir/iam/apprunner-instance-trust.json" >/dev/null
  echo "Created role $role_arn"
fi

aws iam attach-role-policy --role-name "$role_name" --policy-arn "$policy_arn"
echo "Attached $policy_name to $role_name"

echo
echo "Instance role ready:"
echo "  $role_arn"
echo "IAM changes take a few seconds to propagate before App Runner can use the role."
