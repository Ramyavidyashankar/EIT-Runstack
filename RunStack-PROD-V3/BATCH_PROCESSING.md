# Batch Processing in RunStack

This document explains how the RunStack solution handles batch processing for both SQS messages and DynamoDB streams.

## Overview

The RunStack solution implements batch processing at two key points:

1. **SQS to Lambda**: `runstack-process-messages` function processes multiple SQS messages in batches
2. **DynamoDB Streams to Lambda**: `runstack-process-jobs` function processes multiple DDB stream records in batches

## SQS Batch Processing

### Configuration

- **Batch Size**: 10 messages per batch (maximum)
- **Maximum Batching Window**: 5 seconds
- **Partial Batch Failure**: Enabled for individual message retry

### Lambda Event Structure

```json
{
  "Records": [
    {
      "messageId": "059f36b4-87a3-44ab-83d2-661975830a7d",
      "receiptHandle": "AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...",
      "body": "{\"id\":\"notification-001\",\"region\":\"us-east-1\",...}",
      "attributes": {
        "ApproximateReceiveCount": "1",
        "SentTimestamp": "1545082649183"
      },
      "messageAttributes": {},
      "md5OfBody": "e4e68fb7bd0e697a0ae8f1bb342846b3",
      "eventSource": "aws:sqs",
      "eventSourceARN": "arn:aws:sqs:us-east-1:123456789012:runstack-notification-queue",
      "awsRegion": "us-east-1"
    }
  ]
}
```

### Processing Logic

#### Individual Message Processing

The `runstack-process-messages` Lambda function processes each SQS message individually within a batch:

1. **Extract Message Body**: Parse JSON payload from message body
2. **Validate Payload**: Check required fields and parameter formats
3. **Store in DynamoDB**: Create job record with PENDING status
4. **Return Status**: Indicate success or failure for batch response

#### Batch Response Handling

The Lambda function returns a partial batch failure response to indicate which messages failed processing:

- **Successful Messages**: Processed and stored in DynamoDB
- **Failed Messages**: Returned in `batchItemFailures` for retry
- **Batch Response**: Contains list of failed message identifiers

### Error Handling

- **Individual Failures**: Failed messages are retried individually
- **Batch Failures**: Entire batch is retried if Lambda function fails
- **Dead Letter Queue**: Messages that exceed retry attempts are sent to DLQ
- **Visibility Timeout**: 6 times the Lambda timeout (30 seconds = 180 seconds)

### Benefits

- **Reduced Lambda Invocations**: Process up to 10 messages per invocation
- **Cost Optimization**: Lower Lambda execution costs
- **Improved Throughput**: Higher message processing rate
- **Fault Tolerance**: Individual message retry without affecting batch

## DynamoDB Streams Batch Processing

### Configuration

- **Batch Size**: 10 records per batch (maximum)
- **Maximum Batching Window**: 5 seconds
- **Starting Position**: LATEST (only new records)
- **Parallelization Factor**: 1 (sequential processing per shard)

### Lambda Event Structure

```json
{
  "Records": [
    {
      "eventID": "1",
      "eventName": "INSERT",
      "eventVersion": "1.0",
      "eventSource": "aws:dynamodb",
      "awsRegion": "us-east-1",
      "dynamodb": {
        "Keys": {
          "job_id": {"S": "059f36b4-87a3-44ab-83d2-661975830a7d"}
        },
        "NewImage": {
          "job_id": {"S": "059f36b4-87a3-44ab-83d2-661975830a7d"},
          "notification_id": {"S": "notification-001"},
          "status": {"S": "PENDING"},
          "automation_data": {
            "M": {
              "DocumentName": {"S": "AWS-RestartEC2Instance"},
              "Parameters": {
                "M": {
                  "InstanceId": {"L": [{"S": "i-1234567890abcdef0"}]}
                }
              }
            }
          }
        },
        "SequenceNumber": "111",
        "SizeBytes": 26,
        "StreamViewType": "NEW_AND_OLD_IMAGES"
      }
    }
  ]
}
```

### Processing Logic

#### Record Filtering

The `runstack-process-jobs` Lambda function filters DynamoDB stream records to process only relevant events:

- **INSERT Events Only**: Only process new job records
- **Skip MODIFY/REMOVE**: Ignore updates and deletions
- **Validate Structure**: Ensure required fields exist in NewImage

#### Batch Processing

The Lambda function processes multiple DynamoDB stream records in a single invocation:

1. **Filter Records**: Process only INSERT events with valid structure
2. **Convert Format**: Transform DynamoDB format to standard JSON
3. **Prepare Input**: Format data for Step Function execution
4. **Start Executions**: Trigger Step Function for each valid job
5. **Log Results**: Track processing statistics and failures

### Error Handling

- **Record-Level Errors**: Individual records can fail without affecting batch
- **Retry Logic**: Failed records are retried with exponential backoff
- **Maximum Retry Age**: 24 hours (configurable)
- **Bisect on Error**: Split batch in half when errors occur
- **Dead Letter Queue**: Not applicable for DDB streams (use CloudWatch alarms)

### Benefits

- **Efficient Processing**: Handle multiple job creations in single invocation
- **Ordered Processing**: Maintains order within each shard
- **Automatic Scaling**: Scales with DynamoDB write activity
- **Real-time Processing**: Near real-time job triggering

## Performance Considerations

### SQS Batch Processing

- **Optimal Batch Size**: 10 messages for maximum efficiency
- **Memory Usage**: Scale Lambda memory based on batch size
- **Timeout**: Set to accommodate largest expected batch processing time
- **Concurrency**: Control concurrent executions to avoid downstream throttling

### DynamoDB Streams Batch Processing

- **Shard Management**: Each shard processes records sequentially
- **Throughput**: Limited by Step Function execution rate
- **Latency**: Minimize processing time to reduce stream lag
- **Error Recovery**: Implement proper error handling to avoid stream blocking

## Best Practices

### SQS Batch Processing

1. **Validate Early**: Validate messages before expensive operations
2. **Partial Failures**: Use partial batch failure responses
3. **Idempotency**: Ensure processing is idempotent
4. **Monitoring**: Monitor queue depth and processing rates
5. **DLQ Handling**: Implement DLQ message analysis and reprocessing

### DynamoDB Streams Batch Processing

1. **Filter Records**: Process only relevant record types (INSERT)
2. **Error Isolation**: Handle individual record errors gracefully
3. **Downstream Limits**: Respect Step Function execution limits
4. **Data Conversion**: Efficiently convert DynamoDB format to JSON
5. **Logging**: Log processing statistics for monitoring

## Troubleshooting

### Common Issues

#### SQS Messages Not Processing

- Check Lambda function errors in CloudWatch Logs
- Verify SQS queue permissions and visibility timeout
- Review batch size and timeout configurations

#### DynamoDB Stream Lag

- Monitor Lambda function duration and errors
- Check Step Function execution limits and throttling
- Verify DynamoDB stream configuration

#### Partial Batch Failures

- Review individual message validation errors
- Check DynamoDB write permissions and capacity
- Monitor Lambda memory and timeout settings

### Debugging Commands

```bash
# Check SQS queue attributes
aws sqs get-queue-attributes --queue-url {queue-url} --attribute-names All

# Monitor DynamoDB stream
aws dynamodb describe-stream --stream-arn {stream-arn}

# View Lambda function metrics
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Duration --dimensions Name=FunctionName,Value=runstack-process-messages
```
