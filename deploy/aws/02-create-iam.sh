#!/usr/bin/env bash
# Creates the application IAM policy, the App Runner instance role and the
# signer role whose sessions sign the presigned URLs.
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
signer_role_name="${APP_NAME}-signer"
signer_policy_name="signer"
policy_arn="arn:aws:iam::${account_id}:policy/${policy_name}"
role_arn="arn:aws:iam::${account_id}:role/${role_name}"
ec2_role_arn="arn:aws:iam::${account_id}:role/${APP_NAME}-ec2"
signer_role_arn="arn:aws:iam::${account_id}:role/${signer_role_name}"
table_arn="arn:aws:dynamodb:${AWS_REGION}:${account_id}:table/${TABLE_NAME}"

policy_file="$(mktemp)"
current_file="$(mktemp)"
signer_trust_file="$(mktemp)"
signer_policy_file="$(mktemp)"
trap 'rm -f "$policy_file" "$current_file" "$signer_trust_file" "$signer_policy_file"' EXIT
sed \
  -e "s|__S3_BUCKET__|${S3_BUCKET}|g" \
  -e "s|__TABLE_ARN__|${table_arn}|g" \
  -e "s|__SIGNER_ROLE_ARN__|${signer_role_arn}|g" \
  "$script_dir/iam/app-policy.json" > "$policy_file"
sed \
  -e "s|__ACCOUNT_ID__|${account_id}|g" \
  -e "s|__INSTANCE_ROLE_ARN__|${role_arn}|g" \
  -e "s|__EC2_ROLE_ARN__|${ec2_role_arn}|g" \
  "$script_dir/iam/signer-trust.json" > "$signer_trust_file"
sed \
  -e "s|__S3_BUCKET__|${S3_BUCKET}|g" \
  "$script_dir/iam/signer-policy.json" > "$signer_policy_file"

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

# --- Application policy ----------------------------------------------------

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
    echo "Policy $policy_arn already grants bucket $S3_BUCKET, table $TABLE_NAME and role $signer_role_name"
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
    echo "Updated policy $policy_arn to grant bucket $S3_BUCKET, table $TABLE_NAME and role $signer_role_name"
  fi
else
  aws iam create-policy \
    --policy-name "$policy_name" \
    --policy-document "file://$policy_file" >/dev/null
  echo "Created policy $policy_arn"
fi

# --- App Runner instance role ----------------------------------------------

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

# --- Signer role -----------------------------------------------------------
# Trusted through aws:PrincipalArn rather than role principals: IAM refuses
# a trust policy that names a role that does not exist yet (the EC2 role is
# created by ec2/launch.sh), and a condition still matches after a role is
# deleted and recreated under the same name.

if aws iam get-role --role-name "$signer_role_name" >/dev/null 2>&1; then
  aws iam get-role \
    --role-name "$signer_role_name" \
    --query 'Role.AssumeRolePolicyDocument' \
    --output json > "$current_file"
  if same_policy "$signer_trust_file" "$current_file"; then
    echo "Role $signer_role_arn already trusts $role_name and ${APP_NAME}-ec2"
  else
    aws iam update-assume-role-policy \
      --role-name "$signer_role_name" \
      --policy-document "file://$signer_trust_file"
    echo "Updated the trust policy of $signer_role_arn"
  fi
else
  aws iam create-role \
    --role-name "$signer_role_name" \
    --assume-role-policy-document "file://$signer_trust_file" >/dev/null
  echo "Created role $signer_role_arn"
fi

if aws iam get-role-policy \
    --role-name "$signer_role_name" \
    --policy-name "$signer_policy_name" \
    --query 'PolicyDocument' \
    --output json > "$current_file" 2>/dev/null &&
  same_policy "$signer_policy_file" "$current_file"; then
  echo "Inline policy $signer_policy_name on $signer_role_name already grants bucket $S3_BUCKET"
else
  aws iam put-role-policy \
    --role-name "$signer_role_name" \
    --policy-name "$signer_policy_name" \
    --policy-document "file://$signer_policy_file"
  echo "Applied inline policy $signer_policy_name to $signer_role_name"
fi

echo
echo "Instance role ready:"
echo "  $role_arn"
echo "Signer role ready:"
echo "  S3_SIGNER_ROLE_ARN=$signer_role_arn"
echo "IAM changes take a few seconds to propagate before the roles can be used."
