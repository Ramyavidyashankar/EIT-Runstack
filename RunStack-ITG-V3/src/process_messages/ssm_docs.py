"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_ssm_document_detail(event, http_method, path, path_parameters, query_params):
    doc_name = path.split("/ssm/documents/")[-1]
    if not doc_name:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Document name is required"})
        }
    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        ssm = boto3.client("ssm", region_name=region)
        response = ssm.get_document(
            Name=doc_name,
            DocumentFormat="YAML"
        )
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "name": response.get("Name"),
                "document_type": response.get("DocumentType"),
                "document_format": response.get("DocumentFormat"),
                "schema_version": response.get("SchemaVersion"),
                "content": response.get("Content"),
                "status": response.get("Status"),
                "document_version": response.get("DocumentVersion"),
            })
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /ssm/documents ────────────────────────────────────────

def handle_ssm_documents_list(event, http_method, path, path_parameters, query_params):
    doc_type = query_params.get("type", "Command")
    owner = query_params.get("owner", "Self")

    valid_types = ["Command", "Automation", "Policy", "Session"]
    valid_owners = ["Self", "Amazon", "Private"]

    if doc_type not in valid_types:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": f"Invalid type. Must be one of: {', '.join(valid_types)}"})
        }

    if owner not in valid_owners:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": f"Invalid owner. Must be one of: {', '.join(valid_owners)}"})
        }

    result = get_ssm_documents(doc_type, owner)
    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(result, default=decimal_default)
    }

# ── GET /eventbridge/schedules ────────────────────────────────
