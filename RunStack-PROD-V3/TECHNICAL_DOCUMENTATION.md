# DXCIT RunStack Technical Documentation

## 1. Solution Overview

DXCIT RunStack is a serverless automation solution for cross-account SSM execution, triggered by API notifications and scheduled events. It leverages AWS Lambda, Step Functions, SQS, SNS, DynamoDB, S3, Cognito, and API Gateway for secure, scalable automation.

## 2. Architecture

```
API Gateway → SQS Queue → Lambda (process-messages) → DynamoDB →
Lambda (process-jobs) → Step Function → SSM Automation (Cross-Account)
```

- API Gateway: REST API with /v1/notify endpoint
- SQS: Message buffering, DLQ support
- Lambda: Message processing, job orchestration, scheduled automation
- DynamoDB: Job state management, streams
- Step Function: Workflow orchestration, retry logic
- SNS: Email notifications for failures and alarms
- CloudWatch: Monitoring and alerting
- S3: Storage for scheduled automation instance lists
- EventBridge: Scheduled triggers for bulk automation

## 3. IAM Roles and Permissions

### Lambda Functions
- EC2 network interface management
- DynamoDB read/write
- SQS send
- S3 read
- CloudWatch logging

### Step Function Workflow Role
- Lambda invocation
- DynamoDB update/get
- Cross-account role assumption
- SSM automation execution
- SNS publish
- CloudWatch logging

### API Gateway
- CloudWatch logging
- SQS integration (SQSSendMessagePolicy)

### Cross-Account Role (Target Accounts)
- SSM automation
- EC2 management
- S3 access for job outputs

### Cognito & API Gateway Authorizer
- OAuth 2.0 client credentials flow for API access

### Resource-Based Permissions
- Lambda invocation (API Gateway, EventBridge)
- SQS, S3

## 4. Notification and Error Handling

### Job Failure Notifications
- Step Function workflow failure triggers SNS email
- Email includes job details, resource info, error details
- Professional format:

```
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

### CloudWatch Alarms
- DLQ messages, API Gateway throttling, Lambda concurrency limits
- Immediate email notifications via SNS

### SQS/Lambda Error Handling
- Failed SQS messages retried
- Max attempts → DLQ → alarm
- Lambda logs errors, Step Function uses retry logic
- DynamoDB status updates, API Gateway returns proper status codes

## 5. Deployment and Operational Guidance

### Prerequisites
- Create cross-account IAM role in target accounts
- Set up trust and permissions as per provided policy
- Confirm email subscription for SNS notifications

### Deployment
- Use AWS SAM CLI or CloudFormation
- Parameter overrides for email, VPC, subnet, security group, etc.
- Example:
  ```bash
  sam deploy --parameter-overrides pNotificationEmail=admin@company.com
  ```
- Confirm SNS subscription via email link

### Monitoring & Troubleshooting
- CloudWatch Logs: Lambda, Step Function, API Gateway
- DynamoDB: Job status tracking
- SNS: Email alerts for failures and alarms
- SQS: DLQ for failed messages
- Step Function: Execution history

### Security
- Encryption for SQS, DynamoDB, Lambda env vars, Cognito
- Least privilege IAM policies
- OAuth 2.0 authentication for API


## 6. IAM Role User Guide (Central & Workload Accounts)

### Central Account (RunStack Solution)

- **Role Name:** runstack-workflow-role
- **Purpose:** Executes Step Function workflows, assumes cross-account roles, manages job state, triggers SSM automation, sends notifications.
- **Permissions:**
  - Lambda:InvokeFunction
  - DynamoDB:GetItem, DynamoDB:UpdateItem
  - sts:AssumeRole (for workload accounts)
  - ssm:StartAutomationExecution, ssm:SendCommand, ssm:Get*, ssm:Describe*
  - logs:CreateLogGroup, logs:CreateLogStream, logs:PutLogEvents
  - sns:Publish (to notification topic)

#### Example Policy (Central Account)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction",
        "dynamodb:GetItem",
        "dynamodb:UpdateItem",
        "sts:AssumeRole",
        "ssm:StartAutomationExecution",
        "ssm:SendCommand",
        "ssm:Get*",
        "ssm:Describe*",
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "sns:Publish"
      ],
      "Resource": "*"
    }
  ]
}
```

### Workload Account (Target Account)

- **Role Name:** runstack-cross-account-role
- **Purpose:** Allows RunStack central account to execute SSM automation and manage EC2/S3 resources in workload account.
- **Trust Policy:**
  - Trusts the central account’s workflow role for sts:AssumeRole
- **Permissions:**
  - ssm:StartAutomationExecution, ssm:SendCommand, ssm:Get*, ssm:List*, ssm:Describe*
  - ec2:Get*, ec2:List*, ec2:Describe*, ec2:StartInstances, ec2:StopInstances, ec2:RebootInstances
  - s3:PutObject, s3:PutObjectAcl, s3:GetObject, s3:GetBucketLocation (for SSM outputs)

#### Example Trust Policy (Workload Account)
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::{central-account-id}:role/runstack-workflow-role"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

#### Example Permissions Policy (Workload Account)
```json
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
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectAcl",
        "s3:GetObject",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::runstack-job-scheduler-{central-account-id}-*",
        "arn:aws:s3:::runstack-job-scheduler-{central-account-id}-*/ssm-outputs/*"
      ]
    }
  ]
}
```

### Setup Instructions

1. In the workload (target) account, create the IAM role `runstack-cross-account-role`.
2. Set the trust policy to allow the central account’s workflow role to assume it.
3. Attach the permissions policy as shown above.
4. In the central account, ensure the Step Function workflow role (`runstack-workflow-role`) has sts:AssumeRole permission for all workload accounts.
5. Use the provided script (`create-role.sh`) for automated setup.
6. Test cross-account SSM automation by triggering a job from the RunStack API.

## 7. References
Architecture diagram: diagram/DXCIT-RunStack-Architecture.png
CloudFormation/SAM templates: template.yaml, job-scheduler-template.yaml
Lambda source: src/process_messages/app.py, src/process_jobs/app.py, src/scheduler/app.py
Step Function definition: src/step_function/workflow.asl.json

---
For further details, see README.md and component-specific documentation files.