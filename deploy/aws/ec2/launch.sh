#!/usr/bin/env bash
# Launches one EC2 instance for the service and deploys to it: the instance
# role and profile, an SSH key pair, a security group, the instance itself
# (latest Amazon Linux 2023, prepared by user-data.sh on first boot), then
# deploy.sh. Rerunning reuses whatever already exists, including an instance
# tagged Name=<APP_NAME>; a stopped one is started.
#
# Required: AWS_REGION, S3_BUCKET. Optional: APP_NAME (default idv-portal),
# TABLE_NAME (default idv-portal), INSTANCE_TYPE (default t4g.micro),
# KEY_FILE (default ~/.ssh/<APP_NAME>-ec2.pem), PUBLIC_HOST (passed on to
# deploy.sh). Expects 01-create-storage.sh and 02-create-iam.sh to have run.
set -euo pipefail

: "${AWS_REGION:?AWS_REGION is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
APP_NAME="${APP_NAME:-idv-portal}"
TABLE_NAME="${TABLE_NAME:-idv-portal}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.micro}"
KEY_FILE="${KEY_FILE:-$HOME/.ssh/${APP_NAME}-ec2.pem}"

export AWS_PAGER=""

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
account_id="$(aws sts get-caller-identity --query Account --output text)"

policy_arn="arn:aws:iam::${account_id}:policy/${APP_NAME}-app"
role_name="${APP_NAME}-ec2"
profile_name="${APP_NAME}-ec2"
key_name="${APP_NAME}-ec2"
sg_name="${APP_NAME}-ec2"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

if ! aws iam get-policy --policy-arn "$policy_arn" >/dev/null 2>&1; then
  echo "Policy $policy_arn not found; run 02-create-iam.sh first." >&2
  exit 1
fi

# --- Instance role and profile ---------------------------------------------

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  echo "Role $role_name already exists"
else
  aws iam create-role \
    --role-name "$role_name" \
    --assume-role-policy-document "file://$script_dir/../iam/ec2-instance-trust.json" >/dev/null
  echo "Created role $role_name"
fi
aws iam attach-role-policy --role-name "$role_name" --policy-arn "$policy_arn"

if aws iam get-instance-profile --instance-profile-name "$profile_name" >/dev/null 2>&1; then
  echo "Instance profile $profile_name already exists"
else
  aws iam create-instance-profile --instance-profile-name "$profile_name" >/dev/null
  echo "Created instance profile $profile_name"
fi
profile_roles="$(aws iam get-instance-profile \
  --instance-profile-name "$profile_name" \
  --query 'InstanceProfile.Roles[].RoleName' \
  --output text)"
if [ "$profile_roles" != "$role_name" ]; then
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$profile_name" \
    --role-name "$role_name"
  echo "Added $role_name to instance profile $profile_name"
fi

# --- Security group --------------------------------------------------------

vpc_id="$(aws ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"
if [ -z "$vpc_id" ] || [ "$vpc_id" = "None" ]; then
  echo "No default VPC in $AWS_REGION; create one with: aws ec2 create-default-vpc --region $AWS_REGION" >&2
  exit 1
fi

sg_id="$(aws ec2 describe-security-groups \
  --region "$AWS_REGION" \
  --filters "Name=group-name,Values=${sg_name}" "Name=vpc-id,Values=${vpc_id}" \
  --query 'SecurityGroups[0].GroupId' \
  --output text)"
if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
  sg_id="$(aws ec2 create-security-group \
    --region "$AWS_REGION" \
    --group-name "$sg_name" \
    --description "${APP_NAME}: HTTP and HTTPS from anywhere, SSH from the operator" \
    --vpc-id "$vpc_id" \
    --query GroupId \
    --output text)"
  echo "Created security group $sg_id"
else
  echo "Security group $sg_id already exists"
fi

# Adds a TCP ingress rule unless the same one is already there.
allow_tcp() {
  local port="$1" cidr="$2"
  if aws ec2 describe-security-groups \
      --region "$AWS_REGION" \
      --group-ids "$sg_id" \
      --query "SecurityGroups[0].IpPermissions[?IpProtocol=='tcp' && FromPort==\`${port}\` && ToPort==\`${port}\`].IpRanges[].CidrIp" \
      --output text | tr '\t' '\n' | grep -qx "$cidr"; then
    return
  fi
  aws ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$sg_id" \
    --protocol tcp \
    --port "$port" \
    --cidr "$cidr" >/dev/null
  echo "Allowed tcp/$port from $cidr"
}

my_ip="$(curl -fsS https://checkip.amazonaws.com)"
case "$my_ip" in
  *.*.*.*) ;;
  *)
    echo "checkip.amazonaws.com answered '$my_ip'; an IPv4 address is needed for the SSH rule." >&2
    exit 1
    ;;
esac
# SSH stays open to the current address only.
for cidr in $(aws ec2 describe-security-groups \
    --region "$AWS_REGION" \
    --group-ids "$sg_id" \
    --query "SecurityGroups[0].IpPermissions[?IpProtocol=='tcp' && FromPort==\`22\` && ToPort==\`22\`].IpRanges[].CidrIp" \
    --output text); do
  if [ "$cidr" != "${my_ip}/32" ]; then
    aws ec2 revoke-security-group-ingress \
      --region "$AWS_REGION" \
      --group-id "$sg_id" \
      --protocol tcp \
      --port 22 \
      --cidr "$cidr" >/dev/null
    echo "Revoked tcp/22 from $cidr"
  fi
done
allow_tcp 22 "${my_ip}/32"
allow_tcp 80 0.0.0.0/0
allow_tcp 443 0.0.0.0/0

# --- Key pair --------------------------------------------------------------

ensure_key_pair() {
  if aws ec2 describe-key-pairs --region "$AWS_REGION" --key-names "$key_name" >/dev/null 2>&1; then
    if [ -f "$KEY_FILE" ]; then
      echo "Key pair $key_name already exists; using $KEY_FILE"
      return
    fi
    cat >&2 <<EOT
Key pair $key_name exists in $AWS_REGION but $KEY_FILE is missing. AWS does not
hand out the private key again: point KEY_FILE at the file saved when the key
pair was created, or delete the key pair so it can be recreated:
  aws ec2 delete-key-pair --region $AWS_REGION --key-name $key_name
EOT
    exit 1
  fi
  if [ -f "$KEY_FILE" ]; then
    cat >&2 <<EOT
$KEY_FILE exists but there is no key pair named $key_name in $AWS_REGION, so
the file cannot belong to it and is left untouched. Move it away, or set
KEY_FILE to another path.
EOT
    exit 1
  fi
  mkdir -p "$(dirname "$KEY_FILE")"
  if ! (umask 077 && aws ec2 create-key-pair \
      --region "$AWS_REGION" \
      --key-name "$key_name" \
      --key-type ed25519 \
      --key-format pem \
      --query KeyMaterial \
      --output text > "$KEY_FILE"); then
    rm -f "$KEY_FILE"
    exit 1
  fi
  echo "Created key pair $key_name; private key saved to $KEY_FILE"
}

# --- Instance --------------------------------------------------------------

read -r instance_id instance_state <<EOT
$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Name,Values=${APP_NAME}" \
            "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].[InstanceId,State.Name] | [0]' \
  --output text)
EOT

case "$instance_state" in
  running|pending)
    echo "Instance $instance_id (Name=$APP_NAME) is $instance_state; reusing it"
    if [ ! -f "$KEY_FILE" ]; then
      echo "Private key $KEY_FILE not found; set KEY_FILE to the file saved when the instance was launched." >&2
      exit 1
    fi
    ;;
  stopping|stopped)
    echo "Instance $instance_id (Name=$APP_NAME) is $instance_state; starting it"
    if [ ! -f "$KEY_FILE" ]; then
      echo "Private key $KEY_FILE not found; set KEY_FILE to the file saved when the instance was launched." >&2
      exit 1
    fi
    aws ec2 wait instance-stopped --region "$AWS_REGION" --instance-ids "$instance_id"
    aws ec2 start-instances --region "$AWS_REGION" --instance-ids "$instance_id" >/dev/null
    ;;
  *)
    ensure_key_pair

    # AL2023 is published for arm64 and x86_64 only; t2 types also list i386.
    arch="$(aws ec2 describe-instance-types \
      --region "$AWS_REGION" \
      --instance-types "$INSTANCE_TYPE" \
      --query "InstanceTypes[0].ProcessorInfo.SupportedArchitectures[?@=='arm64' || @=='x86_64'] | [0]" \
      --output text)"
    if [ "$arch" != arm64 ] && [ "$arch" != x86_64 ]; then
      echo "$INSTANCE_TYPE supports neither arm64 nor x86_64, the architectures Amazon Linux 2023 is built for." >&2
      exit 1
    fi
    ami_param="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${arch}"

    # Not every zone offers every instance type; pick a default subnet in one that does.
    zones="$(aws ec2 describe-instance-type-offerings \
      --region "$AWS_REGION" \
      --location-type availability-zone \
      --filters "Name=instance-type,Values=${INSTANCE_TYPE}" \
      --query 'InstanceTypeOfferings[].Location' \
      --output text | tr '\t' ',')"
    subnet_id="$(aws ec2 describe-subnets \
      --region "$AWS_REGION" \
      --filters "Name=vpc-id,Values=${vpc_id}" \
                "Name=default-for-az,Values=true" \
                "Name=availability-zone,Values=${zones}" \
      --query 'Subnets[0].SubnetId' \
      --output text)"
    if [ -z "$subnet_id" ] || [ "$subnet_id" = "None" ]; then
      echo "No default subnet in $vpc_id offers $INSTANCE_TYPE (zones: ${zones:-none})." >&2
      exit 1
    fi

    echo "Launching $INSTANCE_TYPE ($arch) from $ami_param in $subnet_id ..."
    attempt=0
    while :; do
      if instance_id="$(aws ec2 run-instances \
          --region "$AWS_REGION" \
          --image-id "resolve:ssm:${ami_param}" \
          --instance-type "$INSTANCE_TYPE" \
          --subnet-id "$subnet_id" \
          --associate-public-ip-address \
          --security-group-ids "$sg_id" \
          --key-name "$key_name" \
          --iam-instance-profile "Name=${profile_name}" \
          --block-device-mappings 'DeviceName=/dev/xvda,Ebs={Encrypted=true,VolumeType=gp3,DeleteOnTermination=true}' \
          --user-data "file://$script_dir/user-data.sh" \
          --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled" \
          --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${APP_NAME}}]" \
          --query 'Instances[0].InstanceId' \
          --output text 2>"$work_dir/run-instances.err")"; then
        break
      fi
      attempt=$((attempt + 1))
      # A new instance profile takes a few seconds to become visible to EC2.
      if [ "$attempt" -lt 12 ] && grep -q "Invalid IAM Instance Profile" "$work_dir/run-instances.err"; then
        sleep 5
        continue
      fi
      cat "$work_dir/run-instances.err" >&2
      exit 1
    done
    echo "Launched instance $instance_id"
    ;;
esac

aws ec2 wait instance-running --region "$AWS_REGION" --instance-ids "$instance_id"
echo "Instance is running; waiting for the status checks (a few minutes) ..."
aws ec2 wait instance-status-ok --region "$AWS_REGION" --instance-ids "$instance_id"

instance_ip="$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --instance-ids "$instance_id" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)"
echo "Public IP: $instance_ip"

# --- SSH and first-boot setup ----------------------------------------------

ssh_opts=(-i "$KEY_FILE" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes)
target="ec2-user@${instance_ip}"

echo "Waiting for SSH ..."
ssh_ready=""
for _ in $(seq 1 30); do
  if ssh "${ssh_opts[@]}" "$target" true 2>/dev/null; then
    ssh_ready=1
    break
  fi
  sleep 5
done
if [ -z "$ssh_ready" ]; then
  cat >&2 <<EOT
$target did not answer over SSH. Check that $KEY_FILE is the key pair's private
key and that the security group allows tcp/22 from $my_ip. If this address was
used by an earlier instance, drop its host key: ssh-keygen -R $instance_ip
EOT
  exit 1
fi

echo "Waiting for the first-boot setup to finish ..."
if ! ssh "${ssh_opts[@]}" "$target" \
    'sudo cloud-init status --wait >/dev/null; docker compose version >/dev/null && test -d /opt/idv-portal'; then
  echo "First-boot setup did not complete; see /var/log/cloud-init-output.log on the instance." >&2
  exit 1
fi

export APP_NAME TABLE_NAME KEY_FILE
INSTANCE_IP="$instance_ip" "$script_dir/deploy.sh"
