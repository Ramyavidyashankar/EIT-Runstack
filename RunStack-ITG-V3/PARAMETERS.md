# RunStack Parameters Documentation

This document describes all parameters used in the RunStack solution.

## CloudFormation Template Parameters

### pSolutionName

- **Type**: String
- **Default**: `csa`
- **Description**: Solution name used as suffix for resource names
- **Constraints**: Must contain only lowercase letters, numbers, and hyphens
- **Pattern**: `^[a-z0-9-]+$`
- **Usage**: Controls naming of all AWS resources for multi-environment deployments

**Example Resource Names with Default Value:**
- API Gateway: `csa-api`
- SQS Queue: `csa-notification-queue`
- DynamoDB Table: `csa-jobs-table`
- Lambda Functions: `csa-process-messages`, `csa-process-jobs`
- Step Function: `csa-workflow`
- IAM Role: `csa-workflow-role`
- SNS Topic: `csa-notifications`
- CloudWatch Alarms: `csa-dlq-cw-alarm`, `csa-api-throttle-alarm`, `csa-lambda-concurrency-alarm`
- Log Group: `/aws/apigateway/csa-api-access-logs`
- Cognito Domain: `csa-auth-{AccountId}`
- OAuth Scope: `csa-api/notify`

### pCrossAccountRoleName
- **Type**: String
- **Default**: `csa-cross-account-role`
- **Description**: Name of the IAM role to assume in target accounts for cross-account SSM execution
- **Usage**: Must match the role name created in target AWS accounts

### pStage
- **Type**: String
- **Default**: `v1`
- **Description**: API Gateway stage name
- **Usage**: Defines the API endpoint path segment

### pLambdaConcurrency
- **Type**: Number
- **Default**: `100`
- **Min Value**: `1`
- **Max Value**: `1000`
- **Description**: Reserved concurrent executions for Lambda functions
- **Usage**: Controls maximum parallel Lambda executions to prevent account-level throttling

### pNotificationEmail
- **Type**: String
- **Required**: Yes
- **Description**: Email address for CloudWatch alarms and job failure notifications
- **Validation Pattern**: `^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`
- **Constraint**: Must be a valid email address
- **Usage**: Creates SNS subscription for email notifications
- **Post-Deployment**: Requires manual confirmation via email link

**Example Usage:**
```bash
sam deploy --parameter-overrides pNotificationEmail=admin@company.com
```

## API Request Parameters

### Required Fields

#### id
- **Type**: String
- **Description**: Unique notification identifier
- **Example**: `"notification-example-001"`
- **Usage**: Used for tracking and deduplication

#### region
- **Type**: String
- **Description**: Target AWS region where automation will execute
- **Example**: `"us-east-1"`
- **Validation**: Must be valid AWS region

#### account_id
- **Type**: String
- **Description**: Target AWS account ID (12-digit number)
- **Example**: `"123456789012"`
- **Validation**: Must be 12-digit numeric string

#### resource_id
- **Type**: String
- **Description**: Target resource identifier (e.g., EC2 instance ID)
- **Example**: `"i-1234567890abcdef0"`
- **Usage**: Passed to SSM automation as target resource

#### automation_type
- **Type**: String
- **Description**: Type of automation to execute
- **Required Values**: `"SSM-Automation"` or `"SSM-RunCommand"`
- **Validation**: Must be one of the two supported values

#### automation_data
- **Type**: Object
- **Description**: SSM automation configuration following AWS API structure
- **Required**: Yes
- **Structure**: Contains DocumentName and parameters following AWS SSM API format
- **Examples**: 

**SSM Automation Configuration:**
```json
{
  "DocumentName": "AWS-RestartEC2Instance",
  "Parameters": {
    "InstanceId": ["i-1234567890abcdef0"]
  }
}
```

**SSM Run Command Configuration:**
```json
{
  "DocumentName": "AWS-RunShellScript",
  "InstanceIds": ["i-1234567890abcdef0"],
  "Parameters": {
    "commands": ["echo Hello", "uptime"]
  }
}
```

- **Validation**: 
  - Must contain `DocumentName` field
  - For SSM-RunCommand: Must contain `InstanceIds` field
  - Parameters must match the requirements of the specified SSM document
{
  "commands": ["echo Hello World", "uptime", "df -h"]
}
```

**SSM Run Command Parameters (Remote Script):**
```json
{
  "sourceType": ["S3"],
  "sourceInfo": ["{\"path\":\"https://bucket.s3.region.amazonaws.com/script.sh\"}"],
  "commandLine": ["script.sh", "arg1", "arg2"]
}
```

### Parameter Transformation

The CSA solution transforms API parameters differently based on automation type:

#### SSM Automation Transformation
**Input Format (API)**:
```json
{
  "automation_type": "SSM-Automation",
  "automation_data": {
    "DocumentName": "AWS-RestartEC2Instance",
    "Parameters": {
      "InstanceId": ["i-1234567890abcdef0"],
      "Force": ["true"]
    }
  }
}
  }
}
```

**Output Format (SSM startAutomationExecution)**:
```json
{
  "DocumentName": "AWS-RestartEC2Instance",
  "Parameters": {
    "InstanceId": ["i-1234567890abcdef0"],
    "Force": ["true"]
  }
}
```

#### SSM Run Command Transformation
**Input Format (API)**:
```json
{
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunShellScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Parameters": {
      "commands": ["echo Hello", "uptime"]
    }
  }
}
```

**Output Format (SSM sendCommand)**:
```json
{
  "DocumentName": "AWS-RunShellScript",
  "InstanceIds": ["i-1234567890abcdef0"],
  "Parameters": {
    "commands": ["echo Hello", "uptime"]
  }
}
{
  "DocumentName": "AWS-RunShellScript",
  "Parameters": {
    "commands": ["echo Hello", "uptime"]
  },
  "InstanceIds": ["i-1234567890abcdef0"]
}
```

#### Remote Script Transformation
**Input Format (API)**:
```json
{
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunRemoteScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Parameters": {
      "sourceType": ["S3"],
      "sourceInfo": ["{\"path\":\"https://bucket.s3.region.amazonaws.com/script.sh\"}"],
      "commandLine": ["script.sh"]
    }
  }
}
```

**Output Format (SSM sendCommand)**:
```json
{
  "DocumentName": "AWS-RunRemoteScript",
  "Parameters": {
    "sourceType": ["S3"],
    "sourceInfo": ["{\"path\":\"https://bucket.s3.region.amazonaws.com/script.sh\"}"],
    "commandLine": ["script.sh"]
  },
  "InstanceIds": ["i-1234567890abcdef0"]
}
```

## Automation Type Examples and Use Cases

### SSM-Automation Examples

#### EC2 Instance Management
```bash
# Restart EC2 Instance
curl -X POST https://api-url/v1/notify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "restart-instance-001",
    "region": "us-east-1",
    "account_id": "123456789012",
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-Automation",
    "automation_data": {
      "DocumentName": "AWS-RestartEC2Instance",
      "Parameters": {
        "InstanceId": ["i-1234567890abcdef0"]
      }
    }
  }'

# Stop EC2 Instance
curl -X POST https://api-url/v1/notify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "stop-instance-001",
    "region": "us-east-1", 
    "account_id": "123456789012",
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-Automation",
    "automation_data": {
      "DocumentName": "AWS-StopEC2Instance",
      "Parameters": {
        "InstanceId": ["i-1234567890abcdef0"],
        "Force": ["false"]
      }
    }
  }'
```

### SSM-RunCommand Examples

#### Shell Script Execution
```bash
# Run inline shell commands
curl -X POST https://api-url/v1/notify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "shell-commands-001",
    "region": "us-east-1",
    "account_id": "123456789012", 
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-RunCommand",
    "automation_data": {
      "DocumentName": "AWS-RunShellScript",
      "InstanceIds": ["i-1234567890abcdef0"],
      "Parameters": {
        "commands": [
          "echo Starting system check",
          "uptime",
          "df -h",
        "free -m",
        "echo System check completed"
      ]
    }
  }
}'
```

#### Remote Script Execution
```bash
# Download and execute script from S3
curl -X POST https://api-url/v1/notify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "remote-script-001",
    "region": "us-east-1",
    "account_id": "123456789012",
    "resource_id": "i-1234567890abcdef0", 
    "automation_type": "SSM-RunCommand",
    "automation_data": {
      "DocumentName": "AWS-RunRemoteScript",
      "InstanceIds": ["i-1234567890abcdef0"],
      "Parameters": {
        "sourceType": ["S3"],
        "sourceInfo": ["{\"path\":\"https://my-scripts-bucket.s3.us-east-1.amazonaws.com/maintenance.sh\"}"],
        "commandLine": ["maintenance.sh", "--verbose", "--check-disk"]
      }
    }
  }'

# PowerShell script execution (Windows instances)
curl -X POST https://api-url/v1/notify \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "id": "powershell-001",
    "region": "us-east-1",
    "account_id": "123456789012",
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-RunCommand", 
    "automation_data": {
      "DocumentName": "AWS-RunPowerShellScript",
      "InstanceIds": ["i-1234567890abcdef0"],
      "Parameters": {
        "commands": [
          "Get-Service | Where-Object {$_.Status -eq \"Running\"} | Select-Object Name,Status",
          "Get-EventLog -LogName System -Newest 10"
        ]
      }
    }
  }'
```

## Environment-Specific Deployment
```bash
sam deploy --parameter-overrides pSolutionName=csa-dev pLambdaConcurrency=50
```

### Production Environment
```bash
sam deploy --parameter-overrides pSolutionName=csa-prod pLambdaConcurrency=200
```

### Multi-Region Deployment
```bash
# US East 1
sam deploy --region us-east-1 --parameter-overrides pSolutionName=csa-use1

# EU West 1
sam deploy --region eu-west-1 --parameter-overrides pSolutionName=csa-euw1
```