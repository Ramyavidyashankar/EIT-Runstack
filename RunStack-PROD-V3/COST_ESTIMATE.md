# RunStack Solution - AWS Cost Estimate
## Based on 1,000,000 Requests per Month

### Executive Summary
- **Total Monthly Cost**: ~$386.42 USD
- **Cost per Request**: ~$0.000386 USD
- **Primary Cost Drivers**: Step Functions (97.3%), Lambda (1.1%), API Gateway (1.0%)
- **Region**: US East (N. Virginia) - us-east-1

---

## Detailed Cost Breakdown

### 1. AWS Lambda Functions (2 Functions)
**Services**: `process-messages`, `process-jobs`

**Assumptions**:
- Average execution time: 500ms per function
- Memory: 256 MB
- Total executions: 2,000,000/month (1M requests × 2 functions)

**Costs**:
- **Duration**: 2,000,000 × 0.5s × 0.25GB = 250,000 GB-seconds
- **Duration Cost**: 250,000 × $0.0000166667 = $4.17
- **Total Lambda**: **$4.17/month**

### 2. AWS Step Functions
**Service**: State machine executions for automation workflow

**Assumptions**:
- 1,000,000 executions per month
- Average 15 state transitions per execution
- Standard Workflows pricing

**Costs**:
- **State Transitions**: 1,000,000 × 15 = 15,000,000 transitions
- **Billable Transitions**: 15,000,000 - 4,000 (free tier) = 14,996,000
- **Cost**: 14,996,000 × $0.000025 = $374.90
- **Total Step Functions**: **$374.90/month**
### 3. Amazon DynamoDB
**Service**: Jobs table for tracking automation status

**Assumptions**:
- 1,000,000 write operations (new jobs)
- 3,000,000 read operations (status checks, updates)
- 2,000,000 update operations (status changes)
- Average item size: 1 KB
- Storage: ~1 GB accumulated per month
- Using On-Demand pricing
- Point-in-Time Recovery enabled for backup

**Costs**:
- **Write Requests**: 3,000,000 × ($0.625/1,000,000) = $1.875
- **Read Requests**: 3,000,000 × ($0.125/1,000,000) = $0.375
- **Storage**: 1 GB × $0.25 = $0.25
- **Backup (Point-in-Time Recovery)**: 1 GB × $0.20 = $0.20
- **Total DynamoDB**: **$2.70/month**

### 4. Amazon SQS
**Services**: Notification queue + DLQ

**Assumptions**:
- 1,000,000 messages sent
- 1,000,000 messages received
- Average message size: 4 KB
- Total requests: 2,000,000/month

**Costs**:
- **Free Tier**: First 1,000,000 requests = $0.00
- **Billable Requests**: 2,000,000 - 1,000,000 = 1,000,000
- **Billable Cost**: 1,000,000 × $0.0000004 = $0.40
- **Total SQS**: **$0.40/month**

### 5. Amazon API Gateway
**Service**: REST API with OAuth2 authentication

**Assumptions**:
- 1,000,000 API calls per month
- Average payload: 2 KB per request (combined request + response)
- Request payload: JSON with automation data (~1 KB)
- Response payload: Status confirmation (~1 KB)

**Costs**:
- **API Calls**: 1,000,000 × $0.0000035 = $3.50
- **Data Transfer**: 1,000,000 requests × 2 KB = 2 GB × $0.09 = $0.18
- **Total API Gateway**: **$3.68/month**
### 6. Amazon Cognito
**Service**: User Pool for OAuth2 authentication

**Assumptions**:
- Client credentials flow
- 1,000,000 token requests per month
- Assuming 10,000 unique client applications (MAU)

**Costs**:
- **Monthly Active Users**: 10,000 MAU (within 50,000 free tier)
- **Total Cognito**: **$0.00/month** (Free Tier)

### 7. Amazon CloudWatch
**Services**: Logs, Metrics, Alarms

**Assumptions**:
- 500 MB logs per month (Lambda + Step Functions)
- 3 custom alarms
- Standard metrics

**Costs**:
- **Log Ingestion**: 500 MB × $0.50/GB = $0.25
- **Log Storage**: 500 MB × $0.03/GB = $0.015
- **Alarms**: 3 × $0.10 = $0.30
- **Total CloudWatch**: **$0.57/month**

### 8. AWS Systems Manager (SSM)
**Service**: Automation and Run Command executions

**Assumptions**:
- 1,000,000 SSM API calls per month
- Standard automation documents

**Costs**:
- **SSM API Calls**: Free for standard documents
- **Total SSM**: **$0.00/month**

---

## Cost Summary by Service

| Service | Monthly Cost | Percentage |
|---------|-------------|------------|
| Step Functions | $374.90 | 97.3% |
| Lambda | $4.17 | 1.1% |
| API Gateway | $3.68 | 1.0% |
| DynamoDB | $2.70 | 0.7% |
| CloudWatch | $0.57 | 0.1% |
| SQS | $0.40 | 0.1% |
| Cognito | $0.00 | 0% |
| SSM | $0.00 | 0% |
| **TOTAL** | **$386.42** | **100%** |
