#!/usr/bin/env bash
# Removes what launch.sh created: the instance, the security group, the key
# pair with its local file, the instance profile and the role. The bucket,
# table, application policy and signer role are shared with the App Runner
# path and are removed by deploy/aws/teardown.sh.
#
# Required: AWS_REGION. Optional: APP_NAME (default idv-portal), KEY_FILE
# (default ~/.ssh/<APP_NAME>-ec2.pem).
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
APP_NAME="${APP_NAME:-idv-portal}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/${APP_NAME}-ec2.pem}"

export AWS_PAGER=""

account_id="$(aws sts get-caller-identity --query Account --output text)"
policy_arn="arn:aws:iam::${account_id}:policy/${APP_NAME}-app"
role_name="${APP_NAME}-ec2"
profile_name="${APP_NAME}-ec2"
key_name="${APP_NAME}-ec2"
sg_name="${APP_NAME}-ec2"

cat <<EOT
This permanently deletes, in $AWS_REGION (account $account_id):
  - EC2 instances tagged       Name=$APP_NAME
  - security group             $sg_name
  - key pair and private key   $key_name, $KEY_FILE
  - instance profile and role  $profile_name, $role_name
The bucket, table, policy and signer role stay; deploy/aws/teardown.sh removes them.
EOT
read -r -p "Type the application name ($APP_NAME) to continue: " answer
if [ "$answer" != "$APP_NAME" ]; then
  echo "Aborted"
  exit 1
fi

# --- Instances -------------------------------------------------------------

read -r -a instance_ids <<EOT
$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${APP_NAME}" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text)
EOT

if [ "${#instance_ids[@]}" -gt 0 ]; then
  read -r -a instance_ips <<EOT
$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "${instance_ids[@]}" \
  --query 'Reservations[].Instances[].PublicIpAddress' \
  --output text)
EOT
  aws ec2 terminate-instances --region "$AWS_REGION" --instance-ids "${instance_ids[@]}" >/dev/null
  echo "Terminating ${instance_ids[*]} ..."
  aws ec2 wait instance-terminated --region "$AWS_REGION" --instance-ids "${instance_ids[@]}"
  echo "Terminated ${instance_ids[*]}"
  for ip in "${instance_ips[@]}"; do
    [ "$ip" = "None" ] || ssh-keygen -R "$ip" >/dev/null 2>&1 || true
  done
else
  echo "No instance tagged Name=$APP_NAME"
fi

# --- Security group --------------------------------------------------------

sg_id="$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --filters "Name=group-name,Values=${sg_name}" \
  --query 'SecurityGroups[0].GroupId' \
  --output text)"

if [ -n "$sg_id" ] && [ "$sg_id" != "None" ]; then
  # The terminated instance's network interface lingers for a short while and
  # blocks the deletion until it is gone.
  deleted=""
  for _ in $(seq 1 24); do
    if aws ec2 delete-security-group --region "$AWS_REGION" --group-id "$sg_id" 2>/dev/null; then
      deleted=1
      break
    fi
    sleep 5
  done
  if [ -z "$deleted" ]; then
    echo "Could not delete security group $sg_id; something still uses it." >&2
    exit 1
  fi
  echo "Deleted security group $sg_id"
else
  echo "No security group named $sg_name"
fi

# --- Key pair --------------------------------------------------------------

if aws ec2 describe-key-pairs --region "$AWS_REGION" --key-names "$key_name" >/dev/null 2>&1; then
  aws ec2 delete-key-pair --region "$AWS_REGION" --key-name "$key_name"
  echo "Deleted key pair $key_name"
else
  echo "No key pair named $key_name"
fi
if [ -f "$KEY_FILE" ]; then
  rm -f "$KEY_FILE"
  echo "Removed $KEY_FILE"
fi

# --- IAM -------------------------------------------------------------------

if aws iam get-instance-profile --instance-profile-name "$profile_name" >/dev/null 2>&1; then
  for attached in $(aws iam get-instance-profile \
      --instance-profile-name "$profile_name" \
      --query 'InstanceProfile.Roles[].RoleName' \
      --output text); do
    aws iam remove-role-from-instance-profile \
      --instance-profile-name "$profile_name" \
      --role-name "$attached"
  done
  aws iam delete-instance-profile --instance-profile-name "$profile_name"
  echo "Deleted instance profile $profile_name"
else
  echo "No instance profile named $profile_name"
fi

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam detach-role-policy --role-name "$role_name" --policy-arn "$policy_arn" 2>/dev/null || true
  aws iam delete-role --role-name "$role_name"
  echo "Deleted role $role_name"
else
  echo "No role named $role_name"
fi

echo
echo "Teardown complete. The bucket, table, policy and signer role are removed by deploy/aws/teardown.sh."
