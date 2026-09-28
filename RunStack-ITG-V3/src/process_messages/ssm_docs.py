"""
SSM documents — GET /ssm/documents and GET /ssm/documents/{name}.

Two callers:
  • Run Automation (TriggerJob.jsx) lists documents for one type/owner in the
    Lambda's own region and reads {name, arn, type, ...}. Without the new
    `regions` parameter the list response is unchanged for it.
  • The SSM Documents page asks for `regions=all`: every configured region
    (SSM_DOC_REGIONS, default us-east-1,us-west-2), with the default/latest
    version, status and description of each document from DescribeDocument.
    An SSM document is regional — a document that exists only in us-east-1
    can't be used by a run in us-west-2 — so each row is one document in one
    region, and `available_in` says where else the same name exists.

Everything shown comes from the SSM API (ListDocuments, DescribeDocument,
ListDocumentVersions, GetDocument). Nothing is inferred from names: when SSM
has no value for a field it is returned as null and the UI says
"Not provided".

Read-only. IAM: ssm:ListDocuments, ssm:DescribeDocument, ssm:GetDocument,
ssm:ListDocumentVersions (all Resource "*", both regions).
"""

import urllib.parse as _urlparse
from concurrent.futures import ThreadPoolExecutor

from botocore.config import Config

from shared import *

VALID_TYPES = ["Command", "Automation", "Policy", "Session"]
VALID_OWNERS = ["Self", "Amazon", "Private"]
SSM_DOC_REGIONS = [r.strip() for r in os.environ.get("SSM_DOC_REGIONS", "us-east-1,us-west-2").split(",") if r.strip()]
MAX_DOCS_PER_REGION = int(os.environ.get("SSM_DOC_MAX_PER_REGION", "300"))
MAX_VERSIONS = 50
_SSM_CONFIG = Config(retries={"mode": "standard", "max_attempts": 6})


def _ssm(region):
    return boto3.client("ssm", region_name=region, config=_SSM_CONFIG)


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def _resp(code, body):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}


# ── GET /ssm/documents/{name}[?region=…&version=…] ─────────────────────────

def _steps_from_content(content):
    """Main steps exactly as written in the document (name, action,
    description if the author gave one). Nothing is guessed."""
    if not isinstance(content, dict):
        return []
    steps = []
    for step in content.get("mainSteps") or []:
        if isinstance(step, dict):
            steps.append({
                "name": step.get("name"),
                "action": step.get("action"),
                "description": step.get("description"),
                "on_failure": step.get("onFailure"),
            })
    if not steps and isinstance(content.get("runtimeConfig"), dict):  # schema 1.2
        for action in content["runtimeConfig"]:
            steps.append({"name": None, "action": action, "description": None, "on_failure": None})
    return steps


def _parameters(describe_params):
    out = []
    for p in describe_params or []:
        out.append({
            "name": p.get("Name"),
            "type": p.get("Type"),
            "description": p.get("Description") or None,
            "default_value": p.get("DefaultValue"),
            "required": "DefaultValue" not in p,
        })
    return out


def _list_versions(ssm, doc_name):
    versions, kwargs = [], {"Name": doc_name, "MaxResults": 50}
    while len(versions) < MAX_VERSIONS:
        page = ssm.list_document_versions(**kwargs)
        for v in page.get("DocumentVersions", []):
            versions.append({
                "version": v.get("DocumentVersion"),
                "version_name": v.get("VersionName"),
                "created_date": _iso(v.get("CreatedDate")),
                "is_default": bool(v.get("IsDefaultVersion")),
                "status": v.get("Status"),
            })
        if not page.get("NextToken"):
            break
        kwargs["NextToken"] = page["NextToken"]
    return versions


def handle_ssm_document_detail(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    doc_name = _urlparse.unquote(path.split("/ssm/documents/")[-1])
    if not doc_name:
        return _resp(400, {"error": "Document name is required"})
    region = qp.get("region") or os.environ.get("AWS_REGION", "us-east-1")
    if region not in SSM_DOC_REGIONS and region != os.environ.get("AWS_REGION", "us-east-1"):
        return _resp(400, {"error": f"region must be one of: {', '.join(SSM_DOC_REGIONS)}"})
    version = str(qp.get("version") or "").strip() or None

    try:
        ssm = _ssm(region)
        described = ssm.describe_document(Name=doc_name, **({"DocumentVersion": version} if version else {}))["Document"]
        default_version = described.get("DefaultVersion")
        latest_version = described.get("LatestVersion")
        shown = version or default_version

        versions, versions_error = [], None
        try:
            versions = _list_versions(ssm, doc_name)
        except ClientError as e:
            # e.g. ssm:ListDocumentVersions not granted yet — still show the document.
            versions_error = e.response.get("Error", {}).get("Code") or str(e)
            logger.warning(f"list_document_versions({doc_name}) failed: {versions_error}")

        # YAML for reading/downloading; JSON only to list the main steps
        # (no YAML parser in the Lambda, and SSM converts either way).
        source_format, content = "YAML", None
        try:
            got = ssm.get_document(Name=doc_name, DocumentVersion=shown, DocumentFormat="YAML")
            content = got.get("Content")
        except ClientError:
            got = ssm.get_document(Name=doc_name, DocumentVersion=shown)
            content, source_format = got.get("Content"), got.get("DocumentFormat") or "JSON"
        steps, content_description = [], None
        try:
            parsed = json.loads(ssm.get_document(Name=doc_name, DocumentVersion=shown, DocumentFormat="JSON").get("Content") or "{}")
            steps = _steps_from_content(parsed)
            content_description = parsed.get("description") if isinstance(parsed, dict) else None
        except (ClientError, ValueError) as e:
            logger.warning(f"Could not read JSON form of {doc_name} v{shown}: {e}")

        # Same-named document in the other configured regions.
        available_in = [region]
        for other in SSM_DOC_REGIONS:
            if other == region:
                continue
            try:
                _ssm(other).describe_document(Name=doc_name)
                available_in.append(other)
            except ClientError:
                pass

        return _resp(200, {
            # fields existing callers read
            "name": described.get("Name"),
            "document_type": described.get("DocumentType"),
            "document_format": source_format,
            "schema_version": described.get("SchemaVersion"),
            "content": content,
            "status": described.get("Status"),
            "document_version": shown,
            # details page
            "region": region,
            "arn": f"arn:aws:ssm:{region}:{described.get('Owner')}:document/{described.get('Name')}"
                   if str(described.get("Owner") or "").isdigit() else None,
            "display_name": described.get("DisplayName") or None,
            "description": described.get("Description") or content_description or None,
            "owner": described.get("Owner"),
            "author": described.get("Author") or None,
            "status_information": described.get("StatusInformation") or None,
            "created_date": _iso(described.get("CreatedDate")),
            "platform_types": described.get("PlatformTypes") or [],
            "target_type": described.get("TargetType") or None,
            "version_name": described.get("VersionName") or None,
            "default_version": default_version,
            "latest_version": latest_version,
            "is_default_version": shown == default_version,
            "is_latest_version": shown == latest_version,
            "parameters": _parameters(described.get("Parameters")),
            "steps": steps,
            "versions": versions,
            "versions_error": versions_error,
            "available_in": available_in,
        })
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("InvalidDocument", "InvalidDocumentVersion"):
            return _resp(404, {"error": f"{doc_name}{f' version {version}' if version else ''} was not found in {region}."})
        return _resp(500, {"error": str(e)})


# ── GET /ssm/documents ────────────────────────────────────────

def _list_region(region, doc_type, owner):
    ssm = _ssm(region)
    filters = [{"Key": "Owner", "Values": [owner]}]
    if doc_type != "All":
        filters.append({"Key": "DocumentType", "Values": [doc_type]})
    items, kwargs, truncated = [], {"Filters": filters, "MaxResults": 50}, False
    while True:
        page = ssm.list_documents(**kwargs)
        items.extend(page.get("DocumentIdentifiers", []))
        if not page.get("NextToken"):
            break
        if len(items) >= MAX_DOCS_PER_REGION:
            truncated = True
            break
        kwargs["NextToken"] = page["NextToken"]
    items = items[:MAX_DOCS_PER_REGION]

    def describe(ident):
        try:
            return ident, ssm.describe_document(Name=ident["Name"])["Document"], None
        except ClientError as e:
            return ident, None, e.response.get("Error", {}).get("Code", "Error")

    with ThreadPoolExecutor(max_workers=12) as pool:
        described = list(pool.map(describe, items))

    rows = []
    for ident, d, err in described:
        d = d or {}
        rows.append({
            "name": ident.get("Name"),
            "display_name": ident.get("DisplayName") or d.get("DisplayName") or None,
            "region": region,
            "owner": ident.get("Owner"),
            "type": ident.get("DocumentType"),
            "document_format": ident.get("DocumentFormat"),
            "schema_version": ident.get("SchemaVersion"),
            "platform": ident.get("PlatformTypes") or [],
            "target_type": ident.get("TargetType") or None,
            "created_date": _iso(ident.get("CreatedDate") or d.get("CreatedDate")),
            "description": d.get("Description") or None,
            "default_version": d.get("DefaultVersion"),
            "latest_version": d.get("LatestVersion"),
            "version_name": d.get("VersionName") or ident.get("VersionName") or None,
            "status": d.get("Status"),
            "status_information": d.get("StatusInformation") or None,
            "parameter_count": len(d.get("Parameters") or []) if d else None,
            "details_error": err,
        })
    return rows, truncated


def handle_ssm_documents_list(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    doc_type = qp.get("type", "Command")
    owner = qp.get("owner", "Self")
    regions_param = qp.get("regions")

    if regions_param is None:
        # Unchanged single-region list (Run Automation).
        if doc_type not in VALID_TYPES:
            return _resp(400, {"error": f"Invalid type. Must be one of: {', '.join(VALID_TYPES)}"})
        if owner not in VALID_OWNERS:
            return _resp(400, {"error": f"Invalid owner. Must be one of: {', '.join(VALID_OWNERS)}"})
        return _resp(200, get_ssm_documents(doc_type, owner))

    if doc_type not in VALID_TYPES + ["All"]:
        return _resp(400, {"error": f"Invalid type. Must be one of: All, {', '.join(VALID_TYPES)}"})
    if owner not in VALID_OWNERS:
        return _resp(400, {"error": f"Invalid owner. Must be one of: {', '.join(VALID_OWNERS)}"})
    regions = SSM_DOC_REGIONS if regions_param in ("", "all") else [r for r in regions_param.split(",") if r]
    bad = [r for r in regions if r not in SSM_DOC_REGIONS]
    if bad:
        return _resp(400, {"error": f"Unsupported region(s) {bad}. Configured: {', '.join(SSM_DOC_REGIONS)}"})

    documents, region_errors, truncated = [], {}, {}
    with ThreadPoolExecutor(max_workers=len(regions)) as pool:
        futures = {r: pool.submit(_list_region, r, doc_type, owner) for r in regions}
        for r, fut in futures.items():
            try:
                rows, cut = fut.result()
                documents.extend(rows)
                truncated[r] = cut
            except ClientError as e:
                region_errors[r] = e.response.get("Error", {}).get("Message") or str(e)
            except Exception as e:  # network etc. — report per region, keep the other
                region_errors[r] = str(e)

    by_name = {}
    for d in documents:
        by_name.setdefault(d["name"], set()).add(d["region"])
    for d in documents:
        d["available_in"] = sorted(by_name[d["name"]])

    documents.sort(key=lambda d: (d["name"].lower(), d["region"]))
    return _resp(200, {
        "documents": documents,
        "count": len(documents),
        "regions": regions,
        "region_errors": region_errors,
        "truncated": truncated,
        "type": doc_type,
        "owner": owner,
        "max_per_region": MAX_DOCS_PER_REGION,
    })
