# Job Scheduling

The RunStack solution provides scheduled automation capabilities using EventBridge rules that trigger Lambda functions to process account and instance lists from S3 CSV files.

## Architecture

```
EventBridge Rule → Job Scheduler Lambda → S3 CSV File → SQS Queue → RunStack Workflow
```

## Components

- **S3 Bucket**: Stores CSV files with account_id,instance_id pairs
- **Job Scheduler Lambda**: Reads S3 CSV files and sends messages to SQS
- **EventBridge Rules**: Trigger automation on schedule
- **Scheduler Template**: CloudFormation template for creating rules

## Setup Instructions

### 1. Get Job Scheduler Bucket Name

After deploying the main RunStack stack, get the job scheduler bucket name:

```bash
aws cloudformation describe-stacks \
  --stack-name stack-custom-serverless-automation \
  --query 'Stacks[0].Outputs[?OutputKey==`JobSchedulerBucketName`].OutputValue' \
  --output text
```

### 2. Create CSV File with Account and Instance Pairs

Create a CSV file with account_id,instance_id pairs (one pair per line):

```bash
# Create CSV file
cat > instances.csv << EOF
account_id,instance_id
123456789012,i-1234567890abcdef0
123456789012,i-0987654321fedcba0
987654321098,i-1111222233334444
987654321098,i-5555666677778888
EOF

# Upload to S3
aws s3 cp instances.csv s3://SCHEDULER_BUCKET_NAME/instances.csv
```

### 3. Deploy Scheduler Rule

Use the `job-scheduler-template.yaml` to create EventBridge rules:

#### SSM Automation Example

```bash
aws cloudformation deploy \
  --template-file job-scheduler-template.yaml \
  --stack-name runstack-scheduler-restart \
  --parameter-overrides \
    pScheduleName=restart-instances \
    pScheduleExpression="rate(6 hours)" \
    pS3File=s3://SCHEDULER_BUCKET_NAME/instances.csv \
    pAutomationType=SSM-Automation
```

#### SSM Run Command Example

```bash
aws cloudformation deploy \
  --template-file job-scheduler-template.yaml \
  --stack-name runstack-scheduler-patch \
  --parameter-overrides \
    pScheduleName=patch-instances \
    pScheduleExpression="cron(0 2 * * ? *)" \
    pS3File=s3://SCHEDULER_BUCKET_NAME/patch-instances.csv \
    pAutomationType=SSM-RunCommand
```

## Parameters

### Required Parameters

- **pScheduleName**: Unique name for the scheduler instance
- **pS3File**: S3 URI containing CSV file with account_id,instance_id pairs

### Optional Parameters

- **pScheduleExpression**: EventBridge schedule (`rate(1 hour)` or `cron(0 9 * * ? *)`)
- **pAutomationType**: `SSM-Automation` or `SSM-RunCommand` (default: SSM-Automation)

## CSV File Format

The S3 file must be in CSV format with account_id,instance_id pairs:

```csv
account_id,instance_id
123456789012,i-1234567890abcdef0
123456789012,i-0987654321fedcba0
987654321098,i-1111222233334444
```

### Format Requirements

- **account_id**: 12-digit AWS account ID
- **instance_id**: EC2 instance ID (e.g., i-1234567890abcdef0)
- **Separator**: Comma (,)
- **No headers**: CSV should contain only data rows

## Schedule Expressions

### Rate Expressions
- `rate(5 minutes)` - Every 5 minutes
- `rate(1 hour)` - Every hour
- `rate(6 hours)` - Every 6 hours
- `rate(1 day)` - Daily

### Cron Expressions
- `cron(0 9 * * ? *)` - Daily at 9:00 AM UTC
- `cron(0 2 * * ? *)` - Daily at 2:00 AM UTC
- `cron(0 9 ? * MON *)` - Every Monday at 9:00 AM UTC
- `cron(0 0 1 * ? *)` - First day of every month at midnight UTC

## Message Generation

For each account_id,instance_id pair in the CSV file, the scheduler generates:

- **ID**: `sch-{schedule_name}-{account_id}-{instance_id}-{random}`
- **Account ID**: From CSV file
- **Region**: Current AWS region where scheduler runs
- **Resource ID**: Instance ID from CSV file

## Placeholders

The scheduler replaces placeholders in payload templates:

- `{{ACCOUNT_ID}}` - Replaced with account_id from CSV
- `{{INSTANCE_ID}}` - Replaced with instance_id from CSV
- `{{REGION}}` - Replaced with current region

Example payload template:
```json
{
  "account_id": "{{ACCOUNT_ID}}",
  "region": "{{REGION}}",
  "resource_id": "{{INSTANCE_ID}}",
  "automation_data": {
    "Parameters": {
      "InstanceId": ["{{INSTANCE_ID}}"]
    }
  }
}
```

## Multiple Schedulers

Deploy multiple schedulers for different use cases:

```bash
# Restart scheduler (every 6 hours)
aws cloudformation deploy \
  --template-file job-scheduler-template.yaml \
  --stack-name runstack-scheduler-restart \
  --parameter-overrides \
    pScheduleName=restart \
    pScheduleExpression="rate(6 hours)" \
    pS3File=s3://SCHEDULER_BUCKET_NAME/restart-instances.csv

# Patch scheduler (daily at 2 AM)
aws cloudformation deploy \
  --template-file job-scheduler-template.yaml \
  --stack-name runstack-scheduler-patch \
  --parameter-overrides \
    pScheduleName=patch \
    pScheduleExpression="cron(0 2 * * ? *)" \
    pS3File=s3://SCHEDULER_BUCKET_NAME/patch-instances.csv

# Health check scheduler (every 30 minutes)
aws cloudformation deploy \
  --template-file job-scheduler-template.yaml \
  --stack-name runstack-scheduler-health \
  --parameter-overrides \
    pScheduleName=health \
    pScheduleExpression="rate(30 minutes)" \
    pS3File=s3://SCHEDULER_BUCKET_NAME/health-instances.csv
```

## Monitoring

Monitor scheduler execution through:

- **CloudWatch Logs**: Job Scheduler Lambda function logs
- **DynamoDB**: Job status tracking
- **Step Functions**: Workflow execution history
- **SNS Notifications**: Failure alerts

## Troubleshooting

### Common Issues

1. **S3 Access Denied**: Ensure the job scheduler Lambda has read access to the S3 bucket
2. **Invalid CSV Format**: Check CSV file format (account_id,instance_id per line)
3. **Invalid Account IDs**: Ensure account IDs are 12 digits
4. **Schedule Not Triggering**: Verify EventBridge rule is enabled and schedule expression is valid
5. **Lambda Timeout**: Large CSV files may require timeout adjustment

### Debugging Steps

1. Check CloudWatch Logs for the job scheduler Lambda
2. Verify S3 CSV file exists and contains valid account_id,instance_id pairs
3. Confirm EventBridge rule is enabled
4. Monitor SQS queue for messages
5. Check DynamoDB for job records