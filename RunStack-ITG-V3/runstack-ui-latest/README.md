# RunStack UI

A Rundeck-style operations console for the RunStack serverless AWS automation solution.  
Built with React 18 + React Router 6, served by nginx on your existing EC2 instance.

---

## Architecture

```
EC2 (nginx) → React SPA → API Gateway (Cognito OAuth2 PKCE) → SQS → Lambda → DynamoDB → Step Function → SSM
```

The UI talks directly to your API Gateway. No backend proxy needed — OAuth tokens
are obtained client-side using the **Cognito Authorization Code + PKCE** flow (public client, no client secret).

### Technology Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18.2 (Create React App) |
| Routing | react-router-dom 6.22 |
| Charts | Recharts 2.12 |
| Date utilities | date-fns 3.3 |
| Auth | AWS Cognito OAuth2 + PKCE (RFC 7636) |
| Hosting | nginx on EC2 |
| Build | react-scripts 5.0.1 |

---

## Quick Start

### 1. Prerequisites

- Node.js 18+ (`node -v`)
- An existing RunStack deployment (`sam deploy` completed)
- Your EC2 instance has nginx installed (`sudo apt install nginx` or `sudo yum install nginx`)

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env` using your CloudFormation stack outputs:

```bash
STACK_NAME="stack-custom-serverless-automation"

# API Gateway URL
aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiGatewayUrl`].OutputValue' --output text

# Cognito Hosted UI Domain
aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoHostedUIDomain`].OutputValue' --output text

# Cognito User Client ID
aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`CognitoUserClientId`].OutputValue' --output text
```

#### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `REACT_APP_API_BASE_URL` | Yes | API Gateway base URL |
| `REACT_APP_COGNITO_HOSTED_UI_DOMAIN` | Yes | Cognito domain (e.g., `runstack.auth.us-east-1.amazoncognito.com`) |
| `REACT_APP_COGNITO_USER_CLIENT_ID` | Yes | OAuth2 app client ID (public client) |
| `REACT_APP_COGNITO_REDIRECT_URI` | No | Redirect after login (defaults to `{origin}/auth/callback`) |
| `REACT_APP_COGNITO_LOGOUT_REDIRECT_URI` | No | Redirect after logout (defaults to origin) |
| `REACT_APP_SOLUTION_NAME` | No | Displayed in sidebar footer (defaults to `runstack-custom-automation`) |

### 3. Run Locally (Development)

```bash
npm install
npm start
# → http://localhost:3000
```

The dev server proxies API requests to `http://localhost:3001` (configured in `package.json`).

### 4. Deploy to EC2

```bash
chmod +x deploy.sh
./deploy.sh ec2-YOUR-IP.compute-1.amazonaws.com ~/.ssh/your-key.pem
# → http://YOUR-EC2-IP/
```

The deploy script:
1. Validates `.env` (checks API_BASE and Cognito config exist)
2. Installs dependencies (`npm ci --silent`)
3. Runs `npm run build` (production React build)
4. Creates `/var/www/runstack-ui` on EC2
5. Rsyncs the `build/` folder to EC2
6. Deploys `nginx/runstack-ui.conf` to `/etc/nginx/sites-available/`
7. Symlinks to `sites-enabled/`, tests config, and reloads nginx

### 5. EC2 Security Group

Ensure your EC2 security group allows **inbound port 80** from your IP (or VPN range).

---

## Authentication & Authorization

### OAuth2 PKCE Flow

The app uses **Authorization Code + PKCE** (RFC 7636) suitable for public SPA clients:

1. User clicks "Sign in with SSO" → app generates PKCE verifier + S256 challenge
2. Browser redirects to Cognito `/authorize` endpoint with challenge
3. After login, Cognito redirects to `/auth/callback` with authorization code
4. App exchanges code + verifier for tokens via `POST /oauth2/token`
5. Tokens stored in **sessionStorage** (survives page refresh, cleared on tab close)

**OAuth Scopes:** `openid email runstack-api/notify`

### Token Management

- Access tokens are auto-refreshed 30 seconds before expiry
- `getValidAccessToken()` is called by every API request
- On 401 response, an `AuthRequiredError` is thrown and session is cleared

### Role-Based Access Control (RBAC)

Roles are extracted from the ID token claim `runstack:role`.

| Role | Rank | Access |
|------|------|--------|
| `admin` | 3 | Full access: Users & Roles, Uploads, all features |
| `operator` | 2 | Schedules, Dead Letter Queue, trigger jobs |
| `viewer` | 1 | Dashboard, Jobs (read-only) |
| `none` | 0 | No access (login page only) |

**Note:** Client-side role checks are UX-only. Backend enforces authorization independently.

---

## Project Structure

```
src/
├── App.jsx              # Route definitions + AuthGate wrapper
├── index.js             # React entry point
├── index.css            # Global styles
├── api/
│   └── client.js        # API client (fetch wrapper with Bearer token)
├── auth/
│   ├── AuthContext.jsx  # Auth provider (login, logout, token refresh)
│   ├── AuthCallback.jsx # /auth/callback route handler
│   ├── Login.jsx        # SSO login page (DXC branding)
│   ├── pkce.js          # PKCE verifier/challenge generation
│   ├── RequireRole.jsx  # Role gate component
│   └── tokenStorage.js  # sessionStorage token persistence
├── components/
│   ├── Layout.jsx       # Sidebar + Topbar layout shell
│   └── ui.jsx           # Reusable UI components (StatusBadge, Btn, Card, etc.)
├── hooks/
│   └── useJobs.js       # Polling hook for jobs list
├── pages/
│   ├── Dashboard.jsx    # Stats, sparkline chart, recent jobs, pipeline diagram
│   ├── Jobs.jsx         # Job list with filters + job detail view
│   ├── Schedules.jsx    # EventBridge schedules, DLQ, Settings views
│   ├── TriggerJob.jsx   # Automation trigger form
│   ├── Uploads.jsx      # S3 file upload (presigned URL, drag & drop)
│   └── UsersRoles.jsx   # User management + role assignment
├── utils/
│   ├── helpers.js       # Formatting (duration, relative time, status metadata)
│   └── uuid.js          # RFC 4122 v4 UUID generator
├── public/
│   └── index.html       # HTML shell
├── nginx/
│   └── runstack-ui.conf # Production nginx config
├── deploy.sh            # EC2 deployment script
└── package.json
```

---

## Routes

| Path | Page | Min Role | Description |
|------|------|----------|-------------|
| `/` | Dashboard | viewer | Stats cards, sparkline, recent jobs, pipeline |
| `/jobs` | Jobs | viewer | Filterable job list (ALL/RUNNING/PENDING/COMPLETED/FAILED) |
| `/jobs/:jobId` | JobDetail | viewer | Single job metadata, payload, execution trace |
| `/trigger` | TriggerJob | viewer | Trigger SSM automation or RunCommand |
| `/schedules` | Schedules | operator | EventBridge schedule list |
| `/dlq` | Dead Letter Queue | operator | SQS DLQ messages with reprocess/delete |
| `/accounts` | Accounts | viewer | Target AWS accounts |
| `/docs` | SSM Documents | viewer | SSM document browser |
| `/uploads` | Uploads | admin | S3 file upload management |
| `/users` | Users & Roles | admin | User role assignment |
| `/settings` | Settings | viewer | Environment config display |
| `/auth/callback` | AuthCallback | — | OAuth2 redirect handler |

---

## API Integration

All API requests use Bearer token authentication via the `apiFetch()` wrapper in `src/api/client.js`.

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/jobs/recent?limit=N&status=FILTER` | Fetch recent jobs (default limit: 20) |
| `GET` | `/jobs/latest` | Get the most recent job |
| `GET` | `/jobs/{jobId}` | Get a single job by ID |

### Trigger / Notify

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/notify` | Trigger a new SSM automation job |

**Payload:**
```json
{
  "id": "uuid-v4",
  "region": "us-east-1",
  "account_id": "123456789012",
  "resource_id": "i-0abc123def456",
  "automation_type": "SSM-Automation",
  "automation_data": { "DocumentName": "...", "Parameters": {...} }
}
```

### SSM & EventBridge

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ssm/documents?type=TYPE&owner=OWNER` | Fetch SSM documents (type: Command/Automation, owner: Self) |
| `GET` | `/eventbridge/schedules?prefix=PREFIX` | Fetch EventBridge schedules |

### S3 Uploads

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/uploads/presign` | Get presigned upload URL |
| `GET` | `/uploads?prefix=PREFIX` | List uploaded files |
| `DELETE` | `/uploads/{key}` | Delete an uploaded file |

**Upload flow:** Request presigned URL → `PUT` file directly to S3 (no auth header) → confirm in UI.

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/users` | List all users with roles |
| `POST` | `/admin/users/{email}/role` | Set user role or app access |

---

## UI Components

### Layout (`src/components/Layout.jsx`)

- **Sidebar** (256px, dark `#12151C`): DXC logo, grouped navigation (Monitor / Automate / Config), user info footer
- **Topbar** (60px): Page title + optional subtitle + action buttons slot
- Navigation items are filtered by `minRole` for the current user

### Reusable Components (`src/components/ui.jsx`)

| Component | Props | Description |
|-----------|-------|-------------|
| `StatusBadge` | `status` | Colored badge with pulsing dot for RUNNING |
| `TypeTag` | `type` | Inline tag (SSM-Automation, SSM-RunCommand) |
| `Btn` | `variant, size, disabled, onClick` | Button (default, primary/orange, danger, ghost) |
| `Card` | `children` | White bordered card |
| `CardHead` | `children, onClick` | Card header with light background |
| `Spinner` | `size` | Animated SVG spinner (orange on gray) |
| `Empty` | `message` | Centered empty state |
| `ErrorBanner` | `message` | Red alert box |
| `StatCard` | `label, value, sub, accent` | Stat display with colored top border |
| `SectionTitle` | `children, sub` | Section heading |
| `MonoField` | `value, dim` | Monospace ID field |
| `Input` | — | Styled text input |
| `Select` | — | Styled dropdown |
| `Textarea` | — | Styled textarea |
| `FormRow` | — | Form field row wrapper |

### Brand Colors

| Name | Hex | Usage |
|------|-----|-------|
| DXC Orange | `#EE6C24` | Primary actions, active nav indicator |
| DXC Red | `#D14600` | Errors, failed status |
| DXC True Blue | `#4995FF` | Running status, info |
| DXC Green | `#007A52` | Success, completed status |
| DXC Gold | `#B87A00` | Pending status, warnings |

---

## Hooks

### `useJobs({ status, limit, pollInterval })`

Auto-polling hook for the jobs list.

```javascript
const { jobs, loading, error, lastFetched, refresh } = useJobs({
  status: 'RUNNING',    // optional filter
  limit: 20,            // default: 20
  pollInterval: 15000   // default: 15s
});
```

- Fetches `GET /jobs/recent` on mount and every `pollInterval` ms
- Handles both `{ jobs: [...] }` and raw array response formats
- Cleans up interval on unmount or dependency change

---

## Nginx Configuration

The production nginx config (`nginx/runstack-ui.conf`) provides:

- **Port 80** listener serving from `/var/www/runstack-ui`
- **Gzip compression** for CSS, JS, JSON, SVG (min 1KB)
- **Static asset caching**: `/static/` → 1-year expires with `Cache-Control: public, immutable`
- **SPA fallback**: `try_files $uri $uri/ /index.html` for client-side routing
- **Security headers**:
  - `X-Frame-Options: SAMEORIGIN`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
- **Optional IP restriction** (commented out): limit to private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`

---

## Pages Detail

### Dashboard
- 4 stat cards (total jobs, success rate, failed count, running count)
- Sparkline area chart of last 12 jobs (pass/fail)
- Recent jobs table (8 rows, auto-refreshes every 15s)
- Quick actions panel (Trigger, View Jobs, Schedules, DLQ)
- Pipeline architecture diagram (API Gateway → SQS → Lambda → DynamoDB → Step Function → SSM)

### Jobs
- Filter tabs: ALL | RUNNING | PENDING | COMPLETED | FAILED (with badge counts)
- Table: Job ID, Notification ID, Document, Type, Account, Region, Resource, Status, Created, Duration
- Click row → detail view with metadata card, automation payload JSON, and 9-step execution trace

### Trigger Job
- Automation type selector (SSM-Automation, SSM-RunCommand)
- SSM document dropdown (fetched from API, filtered by type/owner)
- Form: UUID (auto-generated), Account ID, Region, Resource ID, Document ARN, Parameters (JSON editor)
- RunCommand mode: Instance IDs (comma-separated), Comment field
- 7 optional metadata fields: App ID, App Name, Problem ID, Automation Name, Server Name, OS, Environment
- On success: shows dispatched payload with PENDING badge

### Schedules
- EventBridge schedule table: Name, Schedule expression, State (ENABLED/DISABLED badge), Target count, Description

### Uploads
- Drag & drop zone with progress bars for in-flight uploads
- Flow: `POST /uploads/presign` → `PUT` to S3 presigned URL → display in file list
- File list with size, date, Download & Delete actions

### Users & Roles
- Role capability descriptions (admin / operator / viewer / none)
- Add role form: email + role dropdown
- User roster with inline role selector
- App access form: email + comma-separated app list

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start dev server on port 3000 |
| `npm run build` | Create production build in `build/` |
| `npm test` | Run test suite |

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "API not configured" banner | Check `.env` has `REACT_APP_API_BASE_URL`, `REACT_APP_COGNITO_HOSTED_UI_DOMAIN`, and `REACT_APP_COGNITO_USER_CLIENT_ID` |
| 401 errors on API calls | Token may be expired; app should auto-refresh. Clear sessionStorage and re-login if persistent |
| Blank page after deploy | Ensure nginx `try_files` is configured for SPA routing |
| CORS errors | Verify API Gateway has CORS enabled for your EC2 domain |
| Login redirect loop | Check `REACT_APP_COGNITO_REDIRECT_URI` matches the Cognito app client callback URL exactly |

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard — stats, recent jobs, activity |
| `/jobs` | All jobs with status filter tabs |
| `/jobs/:id` | Job detail — metadata, payload, execution trace |
| `/trigger` | Trigger new job form with live payload preview |
| `/schedules` | EventBridge schedule management |
| `/dlq` | Dead Letter Queue — failed messages |
| `/accounts` | Cross-account SSM targets |
| `/settings` | Environment configuration check |

---

## Updating

```bash
# Edit code, then redeploy:
./deploy.sh ec2-YOUR-IP.compute-1.amazonaws.com ~/.ssh/your-key.pem
```

---

## CORS note

If you see CORS errors in the browser console, add your EC2 IP/hostname to your
API Gateway's allowed origins. You can do this by adding a response header mapping
in your `template.yaml` or via the AWS Console under API Gateway → your API → Settings.
