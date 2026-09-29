# Failure Handling in RunStack

This document explains the comprehensive error handling and failure recovery mechanisms implemented in the RunStack solution, updated with the latest enhancements including enhanced monitoring and batch processing improvements.

## Overview

The RunStack solution implements multi-layered failure handling to ensure:

- **Guaranteed Status Updates**: Job status is always updated regardless of failure point
- **Graceful Degradation**: System continues operating despite component failures
- **Automatic Recovery**: Built-in retry mechanisms for transient failures
- **Comprehensive Monitoring**: Enhanced CloudWatch alarms for proactive failure detection
- **Batch Processing Resilience**: Improved error handling for batch operations

## Enhanced Monitoring and Alerting

### CloudWatch Alarms

The solution now includes enhanced monitoring with three key alarms:

#### 1. Dead Letter Queue Alarm

- **Name**: `{pSolutionName}-dlq-cw-alarm`
- **Metric**: ApproximateNumberOfVisibleMessages
- **Threshold**: ≥ 1 message
- **Purpose**: Immediate notification when messages fail processing

#### 2. API Gateway Throttling Alarm

- **Name**: `{pSolutionName}-api-throttle-alarm`
- **Metric**: 4XXError count
- **Threshold**: ≥ 10 errors in 5 minutes
- **Purpose**: Detect API rate limiting and client errors

#### 3. Lambda Concurrency Alarm

- **Name**: `{pSolutionName}-lambda-concurrency-alarm`
- **Metric**: ConcurrentExecutions
- **Threshold**: ≥ 80% of reserved concurrency
- **Purpose**: Prevent Lambda throttling due to concurrency limits

## Failure Handling by Component

### 1. API Gateway Failures

#### Client Errors (4xx)

- **Invalid JSON**: Returns 400 Bad Request
- **Missing Fields**: Returns 400 Bad Request with validation details
- **Invalid Field Types**: Returns 400 Bad Request
- **Authentication Failures**: Returns 401 Unauthorized
- **Rate Limiting**: Returns 429 Too Many Requests (triggers throttling alarm)

#### Server Errors (5xx)

- **SQS Integration Failure**: Returns 500 Internal Server Error
- **Service Unavailable**: Returns 503 Service Unavailable

#### Enhanced Error Response Format

```json
{
  "error": "ValidationError",
  "message": "automation_data.Parameters.InstanceId must be an array",
  "timestamp": "2025-07-04T15:30:00Z",
  "request_id": "607b433d-5fb9-44fe-997b-e078c59e4ef6"
}
```

### 2. SQS Queue Failures

#### Enhanced Message Processing

- **Visibility Timeout**: 180 seconds (6x Lambda timeout)
- **Max Receive Count**: 3 attempts before DLQ
- **Batch Size**: 10 messages per Lambda invocation
- **Dead Letter Queue**: Enhanced monitoring with immediate alerting

#### DLQ Configuration with Monitoring

```yaml
DeadLetterQueue:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: !Sub '${pSolutionName}-notification-dlq'
    MessageRetentionPeriod: 1209600  # 14 days
    KmsMasterKeyId: alias/aws/sqs

# Enhanced DLQ Monitoring
DLQAlarm:
  Type: AWS::CloudWatch::Alarm
  Properties:
    AlarmName: !Sub '${pSolutionName}-dlq-cw-alarm'
    MetricName: ApproximateNumberOfVisibleMessages
    Threshold: 1
    ComparisonOperator: GreaterThanOrEqualToThreshold
```

### 3. Lambda Function Failures

#### Enhanced Lambda Configuration

- **Reserved Concurrency**: Configurable via `pLambdaConcurrency` parameter (default: 100)
- **Batch Processing**: SQS batch size of 10 messages, DynamoDB stream batch size of 10 records
- **Timeout**: 30 seconds with appropriate SQS visibility timeout (180 seconds)
- **Memory**: Optimized for processing workload
- **Monitoring**: Enhanced CloudWatch metrics and alarms

#### runstack-process-messages Failures

##### Enhanced Validation Errors

The `runstack-process-messages` Lambda implements comprehensive payload validation:

- **Required Fields**: Validates all mandatory fields are present
- **Field Types**: Ensures correct data types for each field
- **Array Parameters**: Validates automation_data.Parameters contain arrays
- **Account ID Format**: Checks 12-digit account ID format
- **Batch Processing**: Handles up to 10 messages per invocation
- **Error Logging**: Logs specific validation failures with request IDs for debugging

##### DynamoDB Write Failures with Batch Support

The Lambda function handles DynamoDB write operations with enhanced retry logic:

- **Batch Writes**: Processes multiple messages efficiently
- **Conditional Writes**: Uses conditional expressions to prevent duplicates
- **Throttling Handling**: Implements exponential backoff for throttling
- **Capacity Errors**: Handles provisioned throughput exceeded errors
- **Idempotent Operations**: Ensures duplicate job IDs are handled gracefully
- **Partial Batch Failures**: Continues processing successful items when some fail
- **Error Recovery**: Retries transient errors with backoff strategy

#### runstack-process-jobs Failures

##### Enhanced DynamoDB Stream Processing

The `runstack-process-jobs` Lambda handles stream processing with improved resilience:

- **Batch Processing**: Handles up to 10 stream records per invocation
- **Event Filtering**: Processes only INSERT events, skips others
- **Concurrent Execution Control**: Limited by reserved concurrency setting
- **Step Function Integration**: Enhanced error handling for workflow initiation
- **Format Conversion**: Converts DynamoDB format to standard JSON
- **Error Isolation**: Individual record failures don't affect batch
- **Logging**: Comprehensive error logging for troubleshooting
- **Continuation**: Processing continues despite individual failures

##### Step Function Start Failures

The Lambda function handles Step Function execution start failures:

- **Execution Limits**: Handles concurrent execution limit errors
- **Throttling**: Implements retry logic for throttling errors
- **Duplicate Names**: Handles execution name conflicts gracefully
- **Service Errors**: Logs and handles Step Function service errors
- **Retry Strategy**: Exponential backoff with jitter for retries

### 4. Step Function Failures

The runstack Step Function implements dual-branch error handling for both automation types with comprehensive failure recovery mechanisms.

#### Enhanced Automation Type Validation

##### CheckAutomationType State

The Step Function now validates and routes based on automation_type:

```json
{
  "CheckAutomationType": {
    "Type": "Choice",
    "Choices": [
      {
        "Variable": "$.automation_type",
        "StringEquals": "SSM-Automation",
        "Next": "SSMAutomationWorkflow"
      },
      {
        "Variable": "$.automation_type", 
        "StringEquals": "SSM-RunCommand",
        "Next": "SSMRunCommandWorkflow"
      }
    ],
    "Default": "UpdateStatusFailed"
  }
}
```

- **Valid Types**: "SSM-Automation" and "SSM-RunCommand"
- **Invalid Types**: Any other value routes to UpdateStatusFailed
- **Error Logging**: Invalid automation types logged with full request context

#### SSM Automation Workflow Failures

##### ExecuteSSMAutomation State

Handles `ssm:startAutomationExecution` failures:

- **Document Not Found**: Invalid automation document name
- **Parameter Mismatch**: automation_data.Parameters don't match document schema
- **Cross-Account Role**: Role assumption failures in target account
- **Service Limits**: SSM concurrent execution limits exceeded
- **Retry Logic**: Up to 3 attempts with exponential backoff

##### MonitorSSMAutomation State  

Handles `ssm:getAutomationExecution` monitoring failures:

- **Status Tracking**: Success, InProgress, Pending, Waiting, Failed, TimedOut, Cancelled
- **Execution Not Found**: Handles deleted or invalid execution IDs
- **Permission Errors**: Cross-account monitoring permission issues
- **Timeout Handling**: Long-running automation timeout management

#### SSM Run Command Workflow Failures

##### ExecuteSSMRunCommand State

Handles `ssm:sendCommand` failures:

- **Instance Validation**: "Instances not in a valid state for account" errors
- **Document Errors**: Invalid command document names
- **Parameter Issues**: Malformed command parameters or missing required fields
- **Instance Connectivity**: SSM agent not running or instance unreachable
- **Service Throttling**: SSM service rate limiting

##### MonitorSSMRunCommand State

Handles `ssm:getCommandInvocation` monitoring failures:

- **Status Tracking**: Success, InProgress, Pending, Delayed, Failed, TimedOut, Cancelled
- **Command Not Found**: Handles invalid command IDs
- **Instance Errors**: Target instance became unavailable during execution
- **Output Retrieval**: Handles command output access issues

### 5. Cross-Account SSM Failures

#### Role Assumption Failures

- **Role Not Found**: Cross-account role doesn't exist
- **Trust Relationship**: Role doesn't trust runstack execution role
- **Permissions**: Role lacks required SSM permissions

#### SSM Automation Failures

- **Document Not Found**: SSM document doesn't exist in target account
- **Invalid Parameters**: Parameters don't match document requirements
- **Instance Not Found**: Target EC2 instance doesn't exist
- **SSM Agent**: SSM agent not running or outdated
- **Permissions**: Instance role lacks required permissions

## Recovery Procedures

### DLQ Message Recovery

```bash
#!/bin/bash
# Script to reprocess DLQ messages

# 1. Receive messages from DLQ
aws sqs receive-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/runstack-notification-dlq \
  --max-number-of-messages 10 \
  --output json > dlq_messages.json

# 2. Analyze and fix messages

# 3. Send fixed messages back to main queue
aws sqs send-message-batch \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/runstack-notification-queue \
  --entries file://fixed_messages.json

# 4. Delete processed messages from DLQ
aws sqs delete-message-batch \
  --queue-url https://sqs.us-east-1.amazonaws.com/123456789012/runstack-notification-dlq \
  --entries file://delete_entries.json
```

## SNS Notification System

### Job Failure Notifications

The runstack solution now includes comprehensive email notifications for job failures through Amazon SNS.

#### Notification Trigger
- **When**: Step Function workflow reaches failure state after all retry attempts
- **Where**: `NotifyJobFailure` state in Step Function workflow
- **Before**: `WorkflowFailed` terminal state

#### Email Format
Job failure notifications include:
- **Subject**: `runstack Job Failure - {automation_type} ({notification_id})`
- **Job Details**: Job ID, notification ID, status, timestamp
- **Resource Information**: AWS account, region, resource ID, automation type
- **Error Details**: Specific failure cause and error message

### Notification Configuration

#### Email Setup
Deploy with notification email parameter:
```bash
sam deploy --parameter-overrides pNotificationEmail=admin@company.com
```

#### Post-Deployment Steps
1. Check email for SNS subscription confirmation
2. Click confirmation link to activate notifications
3. Verify subscription status in AWS SNS console

#### Email Validation
- Regex pattern validates email format during deployment
- Invalid email addresses cause deployment failure
- Subscription requires manual confirmation for security

### Failed Job Recovery

The runstack solution provides mechanisms for recovering failed jobs:

- **Query Failed Jobs**: Identify jobs with FAILED status from recent time periods
- **Analyze Failures**: Determine if failures are recoverable (transient vs permanent)
- **Reset Status**: Reset job status to PENDING for retry
- **Trigger Retry**: Restart Step Function execution for recoverable jobs
- **Manual Intervention**: Flag jobs requiring manual investigation