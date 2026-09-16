#!/bin/bash

# create-role.sh
# Script to create the cross-account IAM role required by RunStack solution

set -e

# Default values
ROLE_NAME="runstack-cross-account-role"
CSA_ACCOUNT_ID="123123123123"
WORKFLOW_ROLE_NAME="runstack-workflow-role"
PROFILE=""

# Function to show usage
show_usage() {
    cat << EOF
Usage: $0 -a CSA_ACCOUNT_ID [OPTIONS]

Required:
  -a CSA_ACCOUNT_ID    AWS account ID where CSA solution is deployed

Optional:
  -r ROLE_NAME         Name of the IAM role (default: runstack-cross-account-role)
  -w WORKFLOW_ROLE_NAME  Workflow role name in CSA account (default: runstack-workflow-role)
  -p PROFILE           AWS CLI profile to use
  -h                   Show this help message

Examples:
  $0 -a 123123123123
  $0 -a 123123123123 -r my-csa-role -p production

EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -a)
            CSA_ACCOUNT_ID="$2"
            shift 2
            ;;
        -r)
            ROLE_NAME="$2"
            shift 2
            ;;
        -w)
            WORKFLOW_ROLE_NAME="$2"
            shift 2
            ;;
        -p)
            PROFILE="$2"
            shift 2
            ;;
        -h)
            show_usage
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$CSA_ACCOUNT_ID" ]]; then
    echo "Error: CSA account ID is required"
    show_usage
    exit 1
fi

# Validate account ID format (12 digits)
if [[ ! "$CSA_ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    echo "Error: Invalid account ID format. Must be 12 digits."
    exit 1
fi

# Set AWS CLI options
AWS_CLI_OPTS=""
if [[ -n "$PROFILE" ]]; then
    AWS_CLI_OPTS="--profile $PROFILE"
fi

# Get current region and account ID
REGION=$(aws configure get region $AWS_CLI_OPTS)
CURRENT_ACCOUNT_ID=$(aws sts get-caller-identity $AWS_CLI_OPTS --query 'Account' --output text)

echo "Creating RunStack cross-account role..."
echo "CSA Account ID: $CSA_ACCOUNT_ID"
echo "Role Name: $ROLE_NAME"
echo "Workflow Role Name: $WORKFLOW_ROLE_NAME"
echo "Region: $REGION"
echo "Current Account ID: $CURRENT_ACCOUNT_ID"

# Create trust policy
TRUST_POLICY=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${CSA_ACCOUNT_ID}:role/${WORKFLOW_ROLE_NAME}"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
)

# Create permissions policy
PERMISSIONS_POLICY=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:StartAutomationExecution",
        "ssm:SendCommand",
        "ssm:Get*",
        "ssm:List*",
        "ssm:Describe*"
      ],
      "Resource": "*"
  },
  {
      "Effect": "Allow",
      "Action": [
        "ec2:Get*",
        "ec2:List*",
        "ec2:Describe*",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:RebootInstances"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowSSMOutputsToS3",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::runstack-job-scheduler-${CSA_ACCOUNT_ID}-*",
        "arn:aws:s3:::runstack-job-scheduler-${CSA_ACCOUNT_ID}-*/ssm-outputs/*"
      ]
    }
  ]
}
EOF
)

# Check if role exists
if aws iam get-role --role-name "$ROLE_NAME" $AWS_CLI_OPTS >/dev/null 2>&1; then
    echo "Role '$ROLE_NAME' already exists. Updating..."
    aws iam update-assume-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-document "$TRUST_POLICY" \
        $AWS_CLI_OPTS
else
    echo "Creating role '$ROLE_NAME'..."
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --assume-role-policy-document "$TRUST_POLICY" \
        --description "Cross-account role for RunStack solution" \
        $AWS_CLI_OPTS
fi

# Create or update policy
POLICY_NAME="${ROLE_NAME}-policy"
POLICY_ARN="arn:aws:iam::${CURRENT_ACCOUNT_ID}:policy/${POLICY_NAME}"

if aws iam get-policy --policy-arn "$POLICY_ARN" $AWS_CLI_OPTS >/dev/null 2>&1; then
    echo "Updating policy..."
    aws iam create-policy-version \
        --policy-arn "$POLICY_ARN" \
        --policy-document "$PERMISSIONS_POLICY" \
        --set-as-default \
        $AWS_CLI_OPTS >/dev/null
else
    echo "Creating policy..."
    aws iam create-policy \
        --policy-name "$POLICY_NAME" \
        --policy-document "$PERMISSIONS_POLICY" \
        $AWS_CLI_OPTS >/dev/null
fi

# Attach policy to role
echo "Attaching policy to role..."
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$POLICY_ARN" \
    $AWS_CLI_OPTS

echo "Success! Role ARN: arn:aws:iam::${CURRENT_ACCOUNT_ID}:role/${ROLE_NAME}"
