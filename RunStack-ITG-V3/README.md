# DXCIT RunStack

A serverless solution that provides an API to receive notification POSTs from third-party systems (such as Dynatrace) and trigger SSM automation documents in other AWS accounts.

## Architecture Overview

The RunStack solution follows a serverless, event-driven architecture:

``` text
API Gateway → SQS Queue → Lambda (process-messages) → DynamoDB → 
Lambda (process-jobs) → Step Function → SSM Automation (Cross-Account)
```

![Architecture Diagram](./diagram/DXCIT-RunStack-Architecture.png)

### Components

- **API Gateway**: REST API with `/v1/notify` endpoint
- **SQS Queue**: Message buffering with DLQ support
- **Lambda Functions**: Message processing, job orchestration, and scheduled automation
- **DynamoDB**: Job state management with streams
- **Step Function**: Workflow orchestration with retry logic
- **SNS Topic**: Email notifications for failures and alarms
- **CloudWatch**: Monitoring and alerting
- **S3 Bucket**: Storage for scheduled automation instance lists
- **EventBridge Rules**: Scheduled triggers for bulk automation

## Key Features

- **Dual SSM Automation Support**: Execute both SSM Automation Documents and SSM Run Commands in target AWS accounts
- **Scheduled Automation**: EventBridge-triggered automation with S3-based instance lists for bulk operations
- **Batch Processing**: Handle multiple messages efficiently (SQS batch size: 10, DDB stream batch size: 10)
- **Error Handling**: Guaranteed status updates and failure recovery
- **Monitoring & Alerting**: CloudWatch alarms for DLQ, API throttling, and Lambda concurrency with SNS email notifications
- **Retry Logic**: Configurable retry mechanism for failed executions (default: 3 attempts, max: 10)
- **Serverless Architecture**: Pay-per-use, auto-scaling components
- **Point-in-Time Recovery**: DynamoDB backup and recovery capabilities
- **Reserved Concurrency**: Lambda functions with configurable concurrency limits

## Prerequisites

### AWS Account Setup

- AWS CLI configured with appropriate permissions
- SAM CLI installed
- Python 3.12 runtime support
- CFN_NAG installed for security scanning (optional but recommended)

### Security Scanning

The solution includes CFN_NAG metadata for security compliance. All identified warnings have been addressed with appropriate suppressions:

```bash
# Install CFN_NAG (if not already installed)
gem install cfn_nag

# Run security scan on template
cfn_nag_scan --input-path template.yaml
```

The template includes metadata suppressions for:

- **W47**: SNS Topic encryption (not required for this use case)

### Cross-Account Role

Create an IAM role named `runstack-cross-account-role` in target accounts with:

- Trust relationship to the RunStack execution role
- Permissions for SSM automation execution
- EC2 instance management permissions

**Quick Setup**: Use the provided script to create the role automatically:

```bash
./create-role.sh -a YOUR_RUNSTACK_ACCOUNT_ID
```

#### Required Trust Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::{runstack-account-id}:role/{pSolutionName}-workflow-role"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

#### Required Permissions Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
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
        }
      ]
    } 
  ]
}
```

## Deployment

### Configuration Parameters

The solution supports the following CloudFormation parameters:

- **pSolutionName** (default: 'runstack'): Solution name used as suffix for all resource names
- **pCrossAccountRoleName** (default: 'runstack-cross-account-role'): IAM role name in target accounts
- **pStage** (default: 'v1'): API Gateway stage name
- **pLambdaConcurrency** (default: 100): Reserved concurrent executions for Lambda functions
- **pMaxRetryAttempts** (default: 3): Maximum retry attempts for SSM executions (range: 1-10)
- **pMaxWaitTimeSeconds** (default: 30): Wait time between SSM status checks in seconds (range: 10-300)
- **pThrottleBurstLimit** (default: 100): API Gateway throttle burst limit (requests per second)
- **pThrottleRateLimit** (default: 50): API Gateway throttle rate limit (requests per second)
- **pQuotaLimit** (default: 10000): API Gateway quota limit (requests per day)

### Deployment Steps

1. **Clone and navigate to solution directory**:

   ```bash
   cd solution
   ```

2. **Build the application**:

   ```bash
   sam build
   ```

3. **Deploy the stack** (with notification email):

   ```bash
   sam deploy --parameter-overrides pNotificationEmail=your-email@domain.com
   ```

4. **Deploy with custom solution name**:

   ```bash
   sam deploy --parameter-overrides \
     pSolutionName=myapp \
     pNotificationEmail=your-email@domain.com
   ```

5. **Deploy with custom retry configuration**:

   ```bash
   # Deploy with 5 retry attempts and 45 second wait time
   sam deploy --parameter-overrides \
     pMaxRetryAttempts=5 \
     pMaxWaitTimeSeconds=45 \
     pNotificationEmail=your-email@domain.com
   ```

6. **Deploy with comprehensive custom configuration**:

   ```bash
   # Deploy with custom retry, concurrency, and throttling settings
   sam deploy --parameter-overrides \
     pSolutionName=prod-runstack \
     pMaxRetryAttempts=5 \
     pMaxWaitTimeSeconds=60 \
     pLambdaConcurrency=200 \
     pThrottleBurstLimit=200 \
     pThrottleRateLimit=100 \
     pNotificationEmail=admin@company.com
   ```

7. **Confirm Email Subscription**: After deployment, check your email for an SNS subscription confirmation and click the confirmation link to receive notifications.

8. **Note the API Gateway URL** from the deployment outputs.

## API Usage

The RunStack API uses Amazon Cognito with OAuth 2.0 client credentials flow for authentication and supports two types of SSM automation.

### Supported Automation Types

#### SSM-Automation

- **Purpose**: Execute SSM Automation Documents
- **Examples**: AWS-RestartEC2Instance, AWS-StopEC2Instance, custom automation documents
- **Parameters**: Document-specific parameters (e.g., InstanceId, Force)

#### SSM-RunCommand

- **Purpose**: Execute SSM Run Commands on EC2 instances
- **Examples**:
  - **AWS-RunShellScript**: Execute shell commands directly
  - **AWS-RunRemoteScript**: Download and execute scripts from S3
  - **AWS-RunPowerShellScript**: Execute PowerShell commands (Windows)
- **Parameters**: Command-specific parameters (e.g., commands, sourceType, sourceInfo, commandLine)

### API Calls Examples

#### SSM Automation Documents

```json
{
  "id": "notification-example-001",
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
}
```

#### SSM Run Commands

```json
{
  "id": "notification-example-002",
  "region": "us-east-1",
  "account_id": "123456789012",
  "resource_id": "i-1234567890abcdef0",
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunShellScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Comment": "RunShellScript execution through RunStack solution",
    "Parameters": {
      "commands": ["echo Hello World", "uptime"]
    }
  }
}
```

#### SSM Run Commands with S3 Remote Script

```json
{
  "id": "notification-s3-script-001",
  "region": "us-east-1",
  "account_id": "123456789012",
  "resource_id": "i-1234567890abcdef0",
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunRemoteScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Comment": "Execute script from S3 bucket",
    "Parameters": {
      "sourceType": ["S3"],
      "sourceInfo": ["{\"path\":\"https://my-scripts-bucket-name.s3.amazonaws.com/scripts/test.sh\"}"],
      "commandLine": ["test.sh"]
    }
  }
}
```

#### SSM Run Commands with GitHub Public Repository

```json
{
  "id": "notification-github-public-001",
  "region": "us-east-1",
  "account_id": "123456789012",
  "resource_id": "i-1234567890abcdef0",
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunRemoteScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Comment": "Execute script from GitHub public repository",
    "Parameters": {
      "sourceType": ["GitHub"],
      "sourceInfo": ["{\"owner\":\"MyGitHubOrganization\", \"repository\":\"MyGitHubRepository\", \"getOptions\":\"branch:main\", \"path\":\"scripts\"}"],
      "commandLine": ["test.sh"]
    }
  }
}
```

#### SSM Run Commands with GitHub Private Repository

```json
{
  "id": "notification-github-private-001",
  "region": "us-east-1",
  "account_id": "123456789012",
  "resource_id": "i-1234567890abcdef0",
  "automation_type": "SSM-RunCommand",
  "automation_data": {
    "DocumentName": "AWS-RunRemoteScript",
    "InstanceIds": ["i-1234567890abcdef0"],
    "Comment": "Execute script from GitHub private repository",
    "Parameters": {
      "sourceType": ["GitHub"],
      "sourceInfo": ["{\"owner\":\"MyGitHubOrganization\", \"repository\":\"MyGitHubRepository\", \"getOptions\":\"branch:main\", \"path\":\"scripts\", \"tokenInfo\":\"{{ssm-secure:MyGitHubToken}}\"}"],
      "commandLine": ["test.sh"]
    }
  }
}
```

**GitHub Personal Access Token Setup:**

To access private repositories, you need to create a GitHub Personal Access Token and store it in AWS SSM Parameter Store:

1. **Generate Token**: Follow the [GitHub documentation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) to create a Personal Access Token with repository access permissions.

2. **Store in SSM Parameter Store**: The token must be stored as a SecureString parameter named `MyGitHubToken` in one of the following ways:
   - **Per-Account Storage**: Store the parameter in each target AWS account's SSM Parameter Store
   - **Centralized Storage**: Store the parameter in the solution account using AWS SSM Advanced Parameter Store tier with cross-account sharing enabled and encrypted with AWS Customer KMS key for secure access across all target accounts

### Field Descriptions

- **id**: Unique notification identifier
- **region**: Target AWS region
- **account_id**: Target AWS account ID
- **resource_id**: Target resource identifier (e.g., EC2 instance ID)
- **automation_type**: Type of automation - must be "SSM-Automation" or "SSM-RunCommand"
- **automation_data**: SSM execution parameters following AWS API structure

#### automation_data Structure

The `automation_data` field follows the AWS SSM API structure:

**For SSM-Automation** (follows [StartAutomationExecution API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_StartAutomationExecution.html)):

- **DocumentName** (required): SSM document name
- **Parameters** (optional): Document parameters as key-value pairs with array values
- **DocumentVersion** (optional): Document version
- **Mode** (optional): Execution mode
- **MaxConcurrency** (optional): Maximum concurrent executions
- **MaxErrors** (optional): Maximum allowed errors

**For SSM-RunCommand** (follows [SendCommand API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_SendCommand.html)):

- **DocumentName** (required): SSM document name
- **InstanceIds** (required): Array of instance IDs
- **Parameters** (optional): Command parameters as key-value pairs with array values
- **Comment** (optional): Execution comment
- **DocumentVersion** (optional): Document version
- **TimeoutSeconds** (optional): Command timeout
- **MaxConcurrency** (optional): Maximum concurrent executions
- **MaxErrors** (optional): Maximum allowed errors

### Use Case Scenarios

#### Incident Response Automation

- **SSM-Automation**: Restart failed services, reboot instances, scale resources
- **SSM-RunCommand**: Collect logs, run diagnostics, apply patches

#### Maintenance Operations  

- **SSM-Automation**: Scheduled instance operations, backup creation
- **SSM-RunCommand**: Software updates, configuration changes, cleanup scripts

#### Security Response

- **SSM-Automation**: Isolate compromised instances, rotate credentials
- **SSM-RunCommand**: Run security scans, collect forensic data, apply security patches

#### Monitoring Integration

- **Dynatrace Integration**: Receive alerts and trigger automated remediation
- **Custom Monitoring**: Third-party tools can trigger RunStack workflows
- **Multi-Account Operations**: Centralized automation across AWS accounts

## DynamoDB Table Schema

### Primary Key

- **job_id** (String): SQS message ID

### Attributes

- **notification_id** (String): Original notification ID
- **account_id** (String): Target account ID
- **region** (String): Target region
- **resource_id** (String): Target resource ID
- **automation_type** (String): Automation type
- **automation_data** (Object): SSM automation configuration containing DocumentName and parameters
- **status** (String): Job status (PENDING/RUNNING/COMPLETED/FAILED)
- **execution_id** (String): Step Function execution ID
- **created_at** (String): Creation timestamp
- **updated_at** (String): Last update timestamp

### Indexes

- **notification_id-index**: Query by notification ID

## Step Function Workflow

The RunStack workflow implements a dual-branch architecture to support both SSM automation types:

### Workflow States

1. **UpdateExecutionId**: Set execution ID and status to RUNNING
2. **CheckAutomationType**: Route based on automation_type field
   - "SSM-Automation" → SSMAutomationWorkflow
   - "SSM-RunCommand" → SSMRunCommandWorkflow
3. **SSMAutomationWorkflow**: Handle SSM Automation Documents
   - InitializeAutomationRetry → ExecuteSSMAutomation → MonitorSSMAutomation
4. **SSMRunCommandWorkflow**: Handle SSM Run Commands  
   - InitializeCommandRetry → ExecuteSSMRunCommand → MonitorSSMRunCommand
5. **UpdateStatusCompleted/Failed**: Final status update

### SSM Automation Workflow

- **ExecuteSSMAutomation**: Uses `ssm:startAutomationExecution` (async mode)
- **MonitorSSMAutomation**: Uses `ssm:getAutomationExecution` to check status
- **Status Handling**: Success, InProgress, Pending, Waiting, Failed, TimedOut, Cancelled
- **Retry Logic**: Configurable retry attempts (default: 3, max: 10) with exponential backoff
- **Wait Time**: Configurable wait time between status checks (default: 30s, range: 10-300s)

### SSM Run Command Workflow  

- **ExecuteSSMRunCommand**: Uses `ssm:sendCommand` (async mode)
- **MonitorSSMRunCommand**: Uses `ssm:getCommandInvocation` to check status
- **Status Handling**: Success, InProgress, Pending, Delayed, Failed, TimedOut, Cancelled
- **Retry Logic**: Configurable retry attempts (default: 3, max: 10) with exponential backoff
- **Wait Time**: Configurable wait time between status checks (default: 30s, range: 10-300s)

### Cross-Account Execution

Both workflows use the same cross-account role assumption pattern:

- Role ARN: `arn:aws:iam::{account_id}:role/{CrossAccountRoleName}`
- Credentials passed to all SSM API calls

### Status Transitions

- **PENDING** → **RUNNING** → **COMPLETED/FAILED**
- All failure paths guarantee final status update in DynamoDB

## Error Handling

- **API Gateway**: Returns 200 for valid requests, 400 for invalid
- **SQS**: Dead Letter Queue for failed message processing
- **Lambda**: Comprehensive error logging and graceful failure
- **Step Function**: Retry logic with exponential backoff
- **DynamoDB**: Guaranteed status updates regardless of failure point

## Monitoring

### CloudWatch Alarms

- **DLQ Messages**: Alert when messages appear in dead letter queue
- **API Gateway Throttling**: Monitor 4XX errors and throttling events
- **Lambda Concurrency**: Alert when concurrent executions approach limits

All alarms are configured to send notifications to the SNS topic for immediate email alerts.

### SNS Notifications

The solution includes email notifications for:

#### Job Failure Notifications

When a Step Function workflow fails, an email notification is sent with:

- Job details (ID, notification ID, status, timestamp)
- Resource information (AWS account, region, resource ID, automation type)
- Error details and failure cause
- Professional email formatting for easy reading

#### CloudWatch Alarm Notifications

All CloudWatch alarms trigger email notifications when:

- Messages appear in the dead letter queue
- API Gateway throttling occurs
- Lambda concurrent executions approach limits

#### Email Format Example

```text
Subject: RunStack Job Failure - SSM-RunCommand (notification-id)

RunStack - JOB FAILURE NOTIFICATION

=== JOB DETAILS ===
Job ID: [uuid]
Notification ID: [user-provided-id]
Status: FAILED
Timestamp: [iso-timestamp]

=== RESOURCE INFORMATION ===
AWS Account: [account-id]
Region: [aws-region]
Resource ID: [resource-id]
Automation Type: [SSM-Automation|SSM-RunCommand]

=== ERROR DETAILS ===
[specific-error-message]

This is an automated notification from the RunStack solution.
```

### CloudWatch Logs

- API Gateway access logs: `/aws/apigateway/{solution-name}-api-access-logs`
- Lambda function execution logs
- Step Function execution history

### Metrics

- API request count and latency
- SQS message processing rate
- Lambda execution duration and errors
- Step Function success/failure rates
- DynamoDB read/write capacity utilization

## Security

### Encryption

- SQS queues encrypted with AWS managed KMS keys
- DynamoDB table encrypted at rest
- Lambda environment variables encrypted
- Cognito User Pool data encrypted at rest

### IAM Policies

- Least privilege access for all components
- Cross-account role assumption for SSM execution
- Resource-based policies for service integration

### Authentication

- OAuth 2.0 client credentials flow
- Application-to-application authentication only
- Scoped access tokens (runstack-api/notify scope)
- No user-based authentication required

## Job Scheduling

The RunStack solution supports scheduled automation using EventBridge rules and S3-based CSV files containing account and instance pairs. This allows you to trigger SSM automation on multiple instances across different accounts at scheduled intervals.

### Quick Start

1. **Upload CSV file to S3**:
   ```bash
   cat > instances.csv << EOF
   123456789012,i-1234567890abcdef0
   123456789012,i-0987654321fedcba0
   EOF
   aws s3 cp instances.csv s3://SCHEDULER_BUCKET_NAME/instances.csv
   ```

2. **Deploy scheduler**:
   ```bash
   aws cloudformation deploy \
     --template-file job-scheduler-template.yaml \
     --stack-name runstack-scheduler-restart \
     --parameter-overrides \
       pScheduleName=restart-instances \
       pScheduleExpression="rate(6 hours)" \
       pS3File=s3://SCHEDULER_BUCKET_NAME/instances.csv \
       pAutomationType=SSM-Automation \
       pDocumentName=AWS-RestartEC2Instance
   ```

For detailed instructions, see [JOB_SCHEDULING.md](./JOB_SCHEDULING.md).

## Testing

### Manual Testing

#### Getting API Access Token

```bash
# Get credentials from CloudFormation stack
STACK_NAME="stack-custom-serverless-automation"
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs[?OutputKey==`CognitoClientId`].OutputValue' --output text)
TOKEN_ENDPOINT=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs[?OutputKey==`CognitoTokenEndpoint`].OutputValue' --output text)
OAUTH_SCOPE=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs[?OutputKey==`CognitoOAuthScope`].OutputValue' --output text)
CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --user-pool-id $(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserPoolId`].OutputValue' --output text) --client-id $CLIENT_ID --query 'UserPoolClient.ClientSecret' --output text)
API_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayUrl`].OutputValue' --output text)

# Get access token
ACCESS_TOKEN=$(curl -s -X POST $TOKEN_ENDPOINT \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=$OAUTH_SCOPE" | jq -r '.access_token')
```

#### Test SSM-Automation

```bash
# Test inline shell commands (using variables from previous step)
curl -X POST $API_URL/notify \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "id": "test-automation-001",
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
```

#### Test SSM-RunCommand (Shell Script)

```bash
# Test inline shell commands (using variables from previous step)
curl -X POST $API_URL/notify \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "id": "test-runcommand-001",
    "region": "us-east-1", 
    "account_id": "123456789012",
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-RunCommand",
    "automation_data": {
      "DocumentName": "AWS-RunShellScript",
      "InstanceIds": ["i-1234567890abcdef0"],
      "Parameters": {
        "commands": ["echo Hello from RunStack", "uptime", "df -h"]
      }
    }
  }'
```

#### Test SSM-RunCommand (Remote Script)

```bash
# Test remote script execution from S3 (using variables from previous step)
curl -X POST $API_URL/notify \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "id": "test-remote-script-001",
    "region": "us-east-1",
    "account_id": "123456789012", 
    "resource_id": "i-1234567890abcdef0",
    "automation_type": "SSM-RunCommand",
    "automation_data": {
      "DocumentName": "AWS-RunRemoteScript",
      "InstanceIds": ["i-1234567890abcdef0"],
      "Parameters": {
        "sourceType": ["S3"],
        "sourceInfo": ["{\"path\":\"https://your-bucket.s3.region.amazonaws.com/script.sh\"}"],
        "commandLine": ["script.sh", "--verbose"]
      }
    }
  }'
```

## Troubleshooting

### Common Issues

#### API Returns 400 Bad Request

- Verify JSON format and required fields
- Check automation_data values
- Validate account_id format (12 digits)

#### Messages in Dead Letter Queue

- Check Lambda function logs for errors
- Verify DynamoDB table permissions
- Review message format validation

#### Step Function Failures

- Verify cross-account role exists and is assumable
- Check SSM document exists in target account
- Review automation parameters format

#### SSM Automation Failures

- Verify EC2 instance exists and is accessible
- Check SSM agent status on target instance
- Review automation document requirements

### Log Analysis

```bash
# View Lambda logs
aws logs filter-log-events --log-group-name /aws/lambda/runstack-process-messages

# View Step Function execution
aws stepfunctions describe-execution --execution-arn {execution-arn}

# Check DynamoDB records
aws dynamodb scan --table-name runstack-jobs-table
```

## Service Quotas

### API Gateway

- **Requests per second**: 10,000 (default)
- **Payload size**: 10 MB maximum

### SQS

- **Messages per second**: 3,000 (standard queue)
- **Message size**: 256 KB maximum
- **Retention period**: 14 days maximum

### Lambda

- **Concurrent executions**: 1,000 (default)
- **Function timeout**: 15 minutes maximum
- **Memory**: 128 MB to 10,240 MB

### DynamoDB

- **Read capacity**: 40,000 units per table
- **Write capacity**: 40,000 units per table
- **Item size**: 400 KB maximum

### Step Functions

- **Executions per second**: 2,000 (default)
- **Execution time**: 1 year maximum
- **State transitions**: 25,000 per execution

### SSM (Target Account)

- **Concurrent automation**: 100 per account
- **Automation documents**: 500 per account
- **Parameter size**: 4 KB per parameter
