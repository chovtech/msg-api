# Wamator — WhatsApp Messaging API

## Codebase Documentation (Senior Engineering Reference)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Technology Stack](#3-technology-stack)
4. [Infrastructure & Deployment](#4-infrastructure--deployment)
5. [Database Schema (Inferred)](#5-database-schema-inferred)
6. [Application Entry Point — `index.js`](#6-application-entry-point--indexjs)
7. [Configuration](#7-configuration)
8. [Middleware](#8-middleware)
9. [Route Modules (API Endpoints)](#9-route-modules-api-endpoints)
10. [Message Queue System (Publisher / Consumer)](#10-message-queue-system-publisher--consumer)
11. [WhatsApp Session Management](#11-whatsapp-session-management)
12. [Utility Modules](#12-utility-modules)
13. [Data Flow — End-to-End Message Lifecycle](#13-data-flow--end-to-end-message-lifecycle)
14. [Security Model](#14-security-model)
15. [Known Issues & Technical Debt](#15-known-issues--technical-debt)

---

## 1. Project Overview

**Wamator** (`whatsapp-messaging-api`) is a multi-tenant WhatsApp messaging platform that exposes a RESTful API for external vendors (API consumers) to:

- Register and manage their own sub-users (`app_users`).
- Attach WhatsApp phone numbers to those users.
- Connect WhatsApp numbers via QR code scanning (using `whatsapp-web.js`).
- Send text and media messages to authorized contact lists.
- Track message delivery status.

The system uses a **producer/consumer architecture** backed by **RabbitMQ** to decouple HTTP request handling from actual WhatsApp message delivery.

### Multi-Tenancy Model

```
Vendor (api_consumer)          ← top-level tenant, identified by API key
  └── App Users (app_users)    ← vendor's end-users
        ├── WhatsApp Numbers   ← phone numbers linked to a user
        ├── Subscriptions      ← plan-based access control
        └── Contact Lists      ← authorized message recipients
```

Each vendor is fully isolated — queries always filter by `api_consumer_id`.

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT / FRONTEND                           │
│                   (connects via HTTP + Socket.IO)                    │
└──────────┬──────────────────────────────────┬────────────────────────┘
           │ REST API                         │ WebSocket (Socket.IO)
           ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         API SERVER (Express)                        │
│   Container: wamator_api  ·  Port 3000                              │
│                                                                      │
│   Routes:                                                            │
│     /vendors    → registration, login, profile update                │
│     /users      → CRUD for app_users (sub-users)                     │
│     //whatsapp-numbers → manage WhatsApp phone numbers               │
│     /connect    → QR-based WhatsApp session init                     │
│     /messages   → publish messages to RabbitMQ                       │
│     /contacts   → manage authorized recipient lists                  │
│                                                                      │
│   Socket.IO → push QR codes, connection status to frontend           │
└──────────┬─────────────────┬─────────────────┬───────────────────────┘
           │                 │                 │
           ▼                 ▼                 ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐
   │   MySQL 8.0  │  │  RabbitMQ    │  │  .wwebjs_auth (Volume)       │
   │  (wamator_   │  │  (wamator_   │  │  WhatsApp session storage    │
   │   mysql)     │  │   rabbitmq)  │  │  shared between api+worker   │
   └──────────────┘  └──────┬───────┘  └──────────────────────────────┘
                            │
                            │ consume: whatsapp_msg_queue
                            ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     WORKER (Consumer Process)                        │
│   Container: wamator_worker                                          │
│   Entry: node src/routes/consumer.js                                 │
│                                                                      │
│   1. Boots all active WhatsApp clients (from DB)                     │
│   2. Connects to RabbitMQ, consumes whatsapp_msg_queue               │
│   3. Delivers text/media messages via whatsapp-web.js                │
│   4. Updates sent_messages status in MySQL                           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

| Layer            | Technology                          | Purpose                                                                 |
|------------------|-------------------------------------|-------------------------------------------------------------------------|
| Runtime          | Node.js 18 (Bullseye)              | Server runtime                                                          |
| Framework        | Express 5.1                         | HTTP routing & middleware                                               |
| WebSocket        | Socket.IO 4.8                       | Real-time QR code delivery, connection status updates                   |
| Database         | MySQL 8.0 (`mysql2/promise`)        | Persistent storage (connection pooling via `createPool`)                |
| Message Broker   | RabbitMQ 3 (`amqplib`)              | Async message queue between API server and worker                       |
| WhatsApp Client  | `whatsapp-web.js` + Puppeteer       | Headless Chromium-based WhatsApp Web automation                         |
| Auth             | bcrypt + crypto                     | Password hashing (bcrypt salted, 10 rounds), API key generation (256-bit random hex) |
| Validation       | `validator.js`                      | Email normalization, phone validation, input trimming                   |
| Phone Parsing    | `libphonenumber-js`                 | E.164 phone number formatting                                          |
| MIME Detection   | `mime-types`                        | Determine message type (image/video/audio/document) from file URLs      |
| Logging          | Winston                             | Structured logging with timestamps to console + `consumer.log`         |
| Containerization | Docker + Docker Compose             | Multi-service orchestration                                             |

---

## 4. Infrastructure & Deployment

### Docker Compose Services

| Service       | Image / Build       | Role                                | Exposed Ports          |
|---------------|---------------------|-------------------------------------|------------------------|
| `mysql`       | `mysql:8.0`         | Primary database                    | Internal only          |
| `phpmyadmin`  | `phpmyadmin`        | DB admin UI                         | `127.0.0.1:9081`       |
| `rabbitmq`    | `rabbitmq:3-mgmt`   | Message broker + management UI      | `127.0.0.1:15672` (UI) |
| `api`         | Built from Dockerfile| Express API server                  | `127.0.0.1:3000`       |
| `worker`      | Built from Dockerfile| Consumer process (same image, different entrypoint) | None   |

### Key Infrastructure Details

- **Shared session volume**: Both `api` and `worker` mount `wamator_sessions` at `/app/.wwebjs_auth`. This is critical — the API server creates WhatsApp sessions during QR connect, and the worker reuses those same session files to send messages.
- **shm_size: 256mb**: Allocated to both `api` and `worker` containers. Required because Puppeteer/Chromium uses `/dev/shm` for shared memory; the default 64MB Docker allocation causes crashes.
- **All ports bound to `127.0.0.1`**: Services are not exposed to the public internet directly (assumes a reverse proxy like Nginx in front).
- **Worker entrypoint override**: `command: ["node", "src/routes/consumer.js"]` — the worker uses the same Docker image as the API but runs the consumer script directly.

### Dockerfile

- Base: `node:18-bullseye`
- Installs Chromium dependencies (for Puppeteer headless browser)
- Production-only `npm install` (`--omit=dev`)
- No health checks or multi-stage build (potential improvement)

---

## 5. Database Schema (Inferred)

The schema is not defined in this repository (likely managed externally or via migrations not present). Tables inferred from SQL queries:

### `api_consumer` (Vendors)

| Column          | Type         | Notes                              |
|-----------------|--------------|-------------------------------------|
| `id`            | INT PK       | Auto-increment                      |
| `name`          | VARCHAR      | Vendor contact name                 |
| `company_name`  | VARCHAR      | Vendor company                      |
| `phone_number`  | VARCHAR      | Vendor phone (WhatsApp)             |
| `email`         | VARCHAR UQ   | Login identifier                    |
| `password_hash` | VARCHAR      | bcrypt hash                         |
| `api_key`       | VARCHAR UQ   | 64-char hex, used for API auth      |

### `app_users` (Vendor's Sub-Users)

| Column              | Type         | Notes                           |
|---------------------|--------------|---------------------------------|
| `id`                | INT PK       |                                 |
| `api_consumer_id`   | INT FK       | → `api_consumer.id`            |
| `external_user_id`  | VARCHAR NULL | Optional vendor-side identifier |
| `name`              | VARCHAR      |                                 |
| `company_name`      | VARCHAR      |                                 |
| `email`             | VARCHAR      |                                 |
| `created_at`        | DATETIME     |                                 |

### `whatsapp_numbers`

| Column          | Type         | Notes                              |
|-----------------|--------------|-------------------------------------|
| `id`            | INT PK       |                                     |
| `app_user_id`   | INT FK       | → `app_users.id`                   |
| `label`         | VARCHAR NULL | Human-readable label                |
| `phone_number`  | VARCHAR      | Raw phone number string             |
| `is_active`     | TINYINT      | 1 = connected, 0 = disconnected    |
| `session_id`    | VARCHAR NULL | WhatsApp session identifier         |
| `created_at`    | DATETIME     |                                     |

### `subscriptions`

| Column          | Type         | Notes                              |
|-----------------|--------------|-------------------------------------|
| `id`            | INT PK       |                                     |
| `app_user_id`   | INT FK       | → `app_users.id`                   |
| `plan_id`       | INT FK       | → `plans.id`                       |
| `status`        | ENUM/VARCHAR | `'active'`, etc.                   |
| `ends_at`       | DATETIME     | Subscription expiry                 |

### `plans`

| Column              | Type     | Notes                            |
|---------------------|----------|----------------------------------|
| `id`                | INT PK   |                                  |
| `max_phone_numbers` | INT      | Max WhatsApp numbers per user    |
| `max_messages`      | INT      | Max messages per billing period  |

### `contact_lists`

Rich contact data model with 30+ columns including CRM-style fields:

| Key Columns                 | Notes                                      |
|-----------------------------|--------------------------------------------|
| `id`, `api_consumer_id`, `app_user_id` | Composite ownership             |
| `name`, `phone_number`, `email`        | Primary contact info             |
| `gender`, `dob`, `age_group`           | Demographics                     |
| `language_preference`, `timezone`      | Communication preferences        |
| `nickname`, `custom_salutation`        | Personalization                  |
| `partner_name`, `anniversary_date`     | Relationship data                |
| `kids_names`, `pets_names`             | JSON arrays                      |
| `job_title`, `industry`               | Professional info                |
| `interests`, `preferred_products`      | JSON arrays                      |
| `message_opt_in`                       | Boolean — messaging consent      |
| `customer_tier`, `average_spend`       | Customer value segmentation      |

### `sent_messages`

| Column          | Type         | Notes                                      |
|-----------------|--------------|---------------------------------------------|
| `batch_id`      | UUID         | Groups messages from single send operation  |
| `api_consumer_id`| INT FK      |                                             |
| `app_user_id`   | INT FK       |                                             |
| `recipient`     | VARCHAR      | Phone number                                |
| `message`       | TEXT         |                                             |
| `channel`       | VARCHAR      | Always `'whatsapp'`                         |
| `status`        | VARCHAR      | `'pending'` → `'sent'` → `'delivered'` / `'failed'` |
| `message_type`  | VARCHAR      | `'text'`, `'image'`, `'video'`, `'audio'`, `'document'` |
| `media_url`     | VARCHAR NULL |                                             |
| `error_message` | TEXT NULL    | Populated on failure                        |
| `sent_at`       | DATETIME     |                                             |
| `delivered_at`  | DATETIME     |                                             |

---

## 6. Application Entry Point — `index.js`

### Boot Sequence

1. Load environment variables via `dotenv`.
2. Create Express app and HTTP server.
3. Attach Socket.IO with CORS configured for `http://localhost:8080`.
4. Set up in-memory `activeConnections` map (`userId → socketId`) for real-time push.
5. Register Socket.IO event listeners:
   - `register_user`: Links a `userId` to the current socket for targeted event delivery.
   - `disconnect`: Cleans up the mapping.
6. Inject `io` and `activeConnections` into `app` settings (accessible in routes via `req.app.get()`).
7. Mount all route modules.
8. Start HTTP server on `PORT` (default 3000).

### Route Mounting

| Mount Path           | Router Module          | Auth Required |
|----------------------|------------------------|---------------|
| `/vendors`           | `vendor.js`            | Mixed*        |
| `/users`             | `users.js`             | Yes           |
| `//whatsapp-numbers` | `whatsappNumbers.js`   | Yes           |
| `/connect`           | `connect.js`           | Yes           |
| `/messages`          | `publisher.js`         | Yes           |
| `/contacts`          | `contacts.js`          | Yes           |

\* `/vendors/register` and `/vendors/login` are public; `/vendors/update` requires auth.

> **Note**: The `//whatsapp-numbers` mount path has a double slash — likely a typo. The actual request path would need `//whatsapp-numbers/...` to match.

---

## 7. Configuration

### `src/config/db.js` — MySQL Connection Pool

- Uses `mysql2/promise` for async/await query support.
- Creates a connection pool with:
  - `connectionLimit: 10` — max simultaneous connections.
  - `waitForConnections: true` — queues requests when pool is exhausted.
  - `queueLimit: 0` — unlimited queue depth (caller waits indefinitely).
- Connection parameters sourced from environment variables: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Exported as a singleton pool used across the entire application.

### Environment Variables

| Variable       | Used By       | Description                              |
|----------------|---------------|------------------------------------------|
| `PORT`         | `index.js`    | HTTP server port (default: 3000)         |
| `DB_HOST`      | `db.js`       | MySQL host                               |
| `DB_USER`      | `db.js`       | MySQL user                               |
| `DB_PASSWORD`  | `db.js`       | MySQL password                           |
| `DB_NAME`      | `db.js`       | MySQL database name                      |
| `DB_PORT`      | Docker only   | Passed to container env but not used in code (pool uses default 3306) |
| `RABBITMQ_URL` | `queue.js`, `consumer.js` | AMQP connection URL              |

---

## 8. Middleware

### `src/middleware/authVendor.js` — API Key Authentication

**Purpose**: Authenticates every protected request by validating the `x-api-key` header against the `api_consumer` table.

**Flow**:

1. Extract `x-api-key` from request headers.
2. If missing → `401 API Key required`.
3. Query `api_consumer` table for matching `api_key`.
4. If no match → `401 Invalid API Key`.
5. On success:
   - `req.vendor` = `{ id, name }` — vendor metadata.
   - `req.apiConsumerId` = vendor's primary key — used in all downstream queries for tenant isolation.
6. Call `next()` to proceed.

**Security Notes**:
- API keys are 64-character hex strings (256-bit entropy), generated via `crypto.randomBytes(32)`.
- Keys are stored in plaintext in the database (not hashed) — this is a trade-off for lookup performance.
- No rate limiting or key rotation mechanisms are implemented.

---

## 9. Route Modules (API Endpoints)

### 9.1 `src/routes/vendor.js` — Vendor Management

Handles vendor (API consumer) lifecycle.

#### `POST /vendors/register` — Public

Registers a new vendor account.

**Logic**:
1. Validates required fields: `name`, `email`, `password`, `company_name`, `phone_number`.
2. Normalizes email (lowercases, trims), validates phone with `validator.isMobilePhone()`.
3. Checks for duplicate email in `api_consumer` table.
4. Hashes password with bcrypt (10 salt rounds).
5. Generates a 64-char hex API key via `crypto.randomBytes(32)`.
6. Inserts record and returns the API key (shown only once).

#### `POST /vendors/login` — Public

Authenticates a vendor.

**Logic**:
1. Looks up vendor by normalized email.
2. Compares password with stored bcrypt hash.
3. Returns vendor profile (minus `password_hash`) including `api_key`.

#### `PUT /vendors/update` — Protected (authVendor)

Updates vendor profile fields (name, company_name, phone_number).

**Logic**:
1. Validates that the `id` in the body matches `req.vendor.id` (prevents updating other vendors).
2. Dynamically builds `UPDATE` SET clause from provided fields only.
3. Validates each field independently before adding to update.

---

### 9.2 `src/routes/users.js` — App User CRUD

Full CRUD for sub-users belonging to the authenticated vendor.

| Method   | Path            | Description                   |
|----------|-----------------|-------------------------------|
| `POST`   | `/users/register` | Create a new app user        |
| `GET`    | `/users/list`    | List all vendor's users       |
| `GET`    | `/users/:id`     | Get single user by ID         |
| `PATCH`  | `/users/:id`     | Update user fields            |
| `DELETE` | `/users/:id`     | Delete user                   |

**Key Logic**:
- Every query includes `AND api_consumer_id = ?` — strict tenant isolation.
- Supports optional `external_user_id` for vendors to link their own user IDs.
- Dynamic field updates (same pattern as vendor update).
- Duplicate email check is scoped to the vendor (`WHERE email = ? AND api_consumer_id = ?`).

---

### 9.3 `src/routes/whatsappNumbers.js` — WhatsApp Number Management

Manages WhatsApp phone numbers attached to app users.

| Method   | Path                                           | Description                        |
|----------|-------------------------------------------------|-----------------------------------|
| `POST`   | `//whatsapp-numbers/:userId/add`               | Add a WhatsApp number to a user   |
| `PATCH`  | `//whatsapp-numbers/:userId/update/:numberId`  | Update a number's label           |
| `GET`    | `//whatsapp-numbers/:userId/list`              | List all numbers for a user       |
| `DELETE` | `//whatsapp-numbers/:userId/delete/:numberId`  | Delete a WhatsApp number          |

**Key Logic in `POST /:userId/add`**:

1. Verify user belongs to the authenticated vendor.
2. **Subscription check**: Query `subscriptions` joined with `plans` to get `max_phone_numbers`.
3. **Limit enforcement**: Count current numbers for the user; reject if at limit.
4. **Cross-vendor duplicate check**: Prevent the same phone number from being registered under the same vendor (even across different users).
5. Insert the number into `whatsapp_numbers`.

> **Important**: Only the label can be updated after creation — the phone number itself is immutable once added.

---

### 9.4 `src/routes/connect.js` — WhatsApp Session Management

The most complex route. Handles WhatsApp QR code generation and session lifecycle.

#### `POST /connect/:userId/:phoneNumber` — Protected

**Purpose**: Initialize a WhatsApp Web session for a given user + phone number pair.

**Flow**:

```
HTTP Request → DB Validation → Create WAWeb Client → Return 202
                                     │
                                     ▼ (async)
                              QR Generated ──→ Socket.IO → Frontend
                              Authenticated
                              Ready ──→ DB: is_active = 1
                              Disconnected ──→ DB: is_active = 0
```

**Detailed Steps**:

1. **Database validation** (single efficient query with JOINs):
   - Verify user + phone number belong to the API consumer.
   - Check for active subscription.
   - Check if number is already connected (`is_active = 1`).
   - Count active numbers against plan limit.

2. **Duplicate session prevention**:
   - `sessionId = "{apiConsumerId}-{userId}-{phoneNumber}"` — deterministic.
   - In-memory `clients` map prevents parallel initialization.

3. **WhatsApp client configuration**:
   - `LocalAuth` strategy with session data persisted to `/app/.wwebjs_auth`.
   - Puppeteer launched in headless mode with Docker-optimized Chromium flags.
   - Critical flags: `--no-sandbox`, `--disable-dev-shm-usage`, `--single-process`.

4. **Immediate HTTP response**: Returns `200 { status: 'processing' }` — the QR code will arrive via Socket.IO.

5. **90-second failsafe timeout**: If the client never reaches `ready` state within 90s, it's destroyed to prevent zombie Chromium processes.

6. **Event Handlers**:
   - `qr`: Converts QR string to base64 Data URL, emits via Socket.IO to the registered user.
   - `authenticated`: Attaches browser-level error listeners for debugging.
   - `ready`: Updates `whatsapp_numbers.is_active = 1` and `session_id` in DB.
   - `disconnected`: Sets `is_active = 0`, clears `session_id`, removes from in-memory map.
   - `auth_failure`: Cleans up and notifies frontend.

**In-Memory State**: `clients` object holds live WhatsApp client instances. This means:
- Sessions survive only while the API server process is running.
- On API server restart, all sessions must be reconnected via QR scan (unless `LocalAuth` has valid session files).

---

### 9.5 `src/routes/contacts.js` — Contact List Management

Rich CRM-like contact management with 30+ fields per contact.

| Method   | Path                            | Description                           |
|----------|---------------------------------|---------------------------------------|
| `POST`   | `/contacts/:id/add`            | Add one or many contacts (bulk)       |
| `PATCH`  | `/contacts/:id/batch-update`   | Update multiple contacts at once      |
| `PATCH`  | `/contacts/:id/:contactId`     | Update a single contact               |
| `DELETE` | `/contacts/:app_user_id/batch-remove` | Batch delete contacts          |
| `GET`    | `/contacts/:app_user_id/list`  | Paginated + searchable contact list   |

**Key Design Decisions**:

- **Bulk insert**: `POST /:id/add` accepts either a single object or an array. Uses MySQL bulk `INSERT ... VALUES ?` for efficiency.
- **Duplicate prevention**: Pre-queries existing phone numbers and filters them out before insert (no `ON DUPLICATE KEY`).
- **Phone normalization**: Uses `libphonenumber-js` to parse and reformat numbers to E.164 (without the `+` prefix) with Nigeria (`NG`) as default country.
- **JSON fields**: `kids_names`, `pets_names`, `interests`, `preferred_products`, `whatsapp_broadcast_preference` are stored as JSON strings.
- **Pagination**: `GET /list` supports `page`, `limit` (default 50), and `search` (searches across `name`, `email`, `phone_number`, `company_name`).
- **Batch update**: Iterates contacts array, builds dynamic UPDATE for each, returns per-contact result status.

---

## 10. Message Queue System (Publisher / Consumer)

### 10.1 Publisher — `src/routes/publisher.js`

**Endpoint**: `POST /messages/`

**Purpose**: Accepts a message payload, validates it, and pushes individual messages to RabbitMQ for async delivery.

**Request Body**:
```json
{
  "contacts": [
    { "number": "08012345678", "metadata": { "name": "John" } }
  ],
  "message": "Hello {{name}}, your order is ready!",
  "user_id": 5,
  "file_url": "https://example.com/receipt.pdf",   // optional
  "caption": "Your receipt",                         // optional
  "template_id": "order_ready"                       // optional metadata
}
```

**Logic**:

1. **Validation**: Requires `contacts` (non-empty array) + `user_id`, plus at least one of `message` or `file_url`.
2. **User ownership check**: Verifies `user_id` belongs to the API consumer.
3. **Subscription check**: Validates an active, non-expired subscription exists.
4. **Contact authorization**: Cross-references all contact numbers against `contact_lists` table. **Every recipient must be a pre-registered contact** — this prevents spam by disallowing arbitrary number messaging.
5. **Batch ID**: Generates a UUID v4 for the entire send operation.
6. **Per-contact processing**:
   - Strips non-digits from phone number.
   - Determines message type from `file_url` extension using `mime-types`.
   - Applies template substitution: `{{key}}` placeholders replaced with contact metadata.
   - Publishes to RabbitMQ queue `whatsapp_msg_queue` with `persistent: true`.
   - Inserts a `sent_messages` row with status `'pending'`.
7. **Response codes**: `200` (all queued), `207` (partial success), `500` (all failed).

### Template Engine

Simple `{{key}}` substitution:
```javascript
function fillTemplate(template, data) {
  return template.replace(/\{\{(.*?)\}\}/g, (_, key) => data[key.trim()] || '');
}
```
Replaces `{{name}}` with `data.name`. Missing keys resolve to empty string.

### Media Type Detection

```javascript
function getMessageType(url) {
  // Extracts file extension, looks up MIME type
  // Returns: 'image' | 'video' | 'audio' | 'document' | 'text'
}
```

---

### 10.2 Queue Connection — `src/routes/queue.js`

Simple RabbitMQ connection factory:
1. Connect to `RABBITMQ_URL`.
2. Create a channel.
3. Assert `whatsapp_msg_queue` exists (creates if needed).
4. Return the channel for publishing.

> **Note**: No connection pooling or reconnection logic. If the RabbitMQ connection drops mid-operation, publishes will fail with an unhandled error.

---

### 10.3 Consumer — `src/routes/consumer.js`

**Runs as a standalone Node.js process** (the worker container).

**Boot Sequence**:

1. **Pre-initialize WhatsApp clients**: Queries all `whatsapp_numbers WHERE is_active = 1`, initializes a `whatsapp-web.js` client for each with retry logic (3 attempts, 2s between retries).
2. **Connect to RabbitMQ**: Asserts `whatsapp_msg_queue`, sets `prefetch(10)` for backpressure control.
3. **Begin consuming messages**.

**Message Processing Flow**:

```
Message from Queue
       │
       ▼
Parse JSON payload
       │
       ▼
Query DB for user's active WhatsApp number + session_id
       │
       ▼
Get or initialize WhatsApp client for this user
       │
       ▼
Format phone number (Nigeria-specific: 0→234 prefix)
       │
       ▼
Check if recipient is registered on WhatsApp
       │── No  → Update sent_messages status='failed', ACK message
       │
       ▼── Yes
Update sent_messages status='sent'
       │
       ▼
Send message (text or media)
       │
       ▼
Update sent_messages status='delivered'
       │
       ▼
ACK message (removed from queue)
```

**Error Handling**:
- On failure: Updates `sent_messages` with error message, calls `channel.nack(msg, false, false)` — message is **discarded** (not requeued). This prevents infinite retry loops for permanently failing messages.

**WhatsApp Client Pool**:
- `whatsappClients` is a `Map<userId, Client>`.
- `initWhatsAppClient()` checks if a ready client already exists; if not, creates and initializes one with a 30-second timeout.
- Clients are initialized **once** at boot, then reused for all messages from that user.

**Graceful Shutdown**:
- Listens for `SIGINT`.
- Closes RabbitMQ channel and connection.
- Destroys all WhatsApp clients (closes Chromium browsers).

**Media Message Handling**:
- Fetches media from URL via `axios` (`responseType: 'arraybuffer'`).
- Converts to base64.
- Creates `MessageMedia` object with appropriate MIME type.
- Sends with optional caption.

**Message Status Lifecycle**:
```
pending → sent → delivered    (happy path)
pending → failed              (not on WhatsApp / send error)
```

> **Note**: The `status = 'sent'` update happens BEFORE the actual send. If the send fails after this update, the status may be inconsistent. The catch block handles this by setting `status = 'failed'`, but the `sent_at` timestamp will already be set.

---

## 11. WhatsApp Session Management

### Session Identity

```
sessionId = "{apiConsumerId}-{userId}-{phoneNumber}"
```

This three-part composite ensures uniqueness across the entire platform.

### Session Storage

- **File system**: `LocalAuth` strategy saves session data (cookies, tokens) to `/app/.wwebjs_auth/{sessionId}/`.
- **Docker volume**: `wamator_sessions` is mounted to `/app/.wwebjs_auth` in both `api` and `worker` containers.
- **Database**: `whatsapp_numbers.session_id` stores the session identifier for lookup by the consumer.

### Session States

| State           | `is_active` | `session_id`   | In-Memory Client |
|-----------------|-------------|----------------|------------------|
| Never connected | 0           | NULL           | None             |
| QR scanning     | 0           | NULL           | Exists in `clients` |
| Connected       | 1           | Set            | Exists           |
| Disconnected    | 0           | NULL           | Removed          |

### Dual-Client Architecture

This is a critical design detail:

- **API Server** (`connect.js`): Creates WhatsApp clients for QR scanning and initial connection. Stores session files. Updates DB on connect/disconnect.
- **Worker** (`consumer.js`): Creates its **own** WhatsApp client instances using the same `sessionId` and session files. Since `LocalAuth` persists session data to the shared volume, the worker can restore sessions without QR scanning.

This means **two independent Chromium processes** may be running for the same WhatsApp account — one in the API server, one in the worker. The session file sharing via `LocalAuth` allows this, but it's worth noting the resource implications.

---

## 12. Utility Modules

### `src/utils/formatPhoneNumber.js`

```javascript
function formatPhoneNumber(rawNumber, defaultCountry = 'NG')
```

- Uses `libphonenumber-js` to parse the input with Nigeria as the default country code.
- Returns E.164 format without the `+` prefix (e.g., `2348012345678`).
- Returns `null` for invalid numbers.
- Used by the contacts module for consistent phone number storage.

### `src/utils/logger.js`

Winston logger with:
- **Level**: `info`
- **Format**: `{timestamp} [{LEVEL}]: {message}`
- **Transports**: Console + File (`consumer.log`)
- Used exclusively by the consumer process.

---

## 13. Data Flow — End-to-End Message Lifecycle

```
1. Vendor calls POST /messages/ with API key + payload
                    │
2. authVendor middleware validates API key
                    │
3. publisher.js validates:
   - user exists and belongs to vendor
   - active subscription exists
   - all contacts are in authorized contact_lists
                    │
4. For each contact:
   - Format phone number
   - Detect message type (text/image/video/audio/document)
   - Fill message template with contact metadata
   - Publish to RabbitMQ 'whatsapp_msg_queue' (persistent)
   - Insert sent_messages row (status: 'pending')
                    │
5. RabbitMQ holds message until consumer picks it up
                    │
6. consumer.js picks up message:
   - Looks up user's active WhatsApp number
   - Gets or initializes WhatsApp client
   - Formats recipient number
   - Checks WhatsApp registration
   - Sends text or media message
   - Updates sent_messages (pending → sent → delivered / failed)
   - ACKs or NACKs the queue message
```

---

## 14. Security Model

### Authentication
- **Vendor auth**: 256-bit random API key via `x-api-key` header.
- **No JWT/session tokens**: The API is stateless — each request is authenticated independently.
- **Password storage**: bcrypt with 10 salt rounds.

### Authorization
- **Tenant isolation**: Every DB query includes `api_consumer_id` filter.
- **User ownership**: Users can only be accessed by their owning vendor.
- **Number ownership**: WhatsApp numbers validated against user AND vendor.
- **Contact authorization**: Messages can only be sent to contacts that exist in the vendor's contact list for that user.

### Input Validation
- Email normalization via `validator.js`.
- Phone number validation via `validator.isMobilePhone()` and `libphonenumber-js`.
- Input trimming on name fields.
- Parameterized SQL queries throughout (SQL injection protected).

### Gaps
- No rate limiting on any endpoint.
- API keys stored in plaintext (not hashed).
- No HTTPS enforcement at application level (relies on reverse proxy).
- No CORS restriction beyond Socket.IO (Express CORS middleware uses default `*`).
- No request body size limits beyond Express defaults.

---

## 15. Known Issues & Technical Debt

| Issue | Severity | Location | Description |
|-------|----------|----------|-------------|
| Double-slash mount path | Medium | `index.js` line 62 | `app.use('//whatsapp-numbers', ...)` — likely should be `/whatsapp-numbers`. Clients must use `//whatsapp-numbers/...` in URLs. |
| `message.js` is empty | Low | `src/routes/message.js` | Imported nowhere, empty file — dead code. |
| No DB migrations | Medium | Project root | Schema is not version-controlled in this repo. |
| No RabbitMQ reconnection | High | `queue.js` | Publisher creates one-shot connection; no retry/reconnect on failure. |
| `sent_at` set before actual send | Low | `consumer.js` | Status updated to `'sent'` before `sendMessage()` call. |
| Consumer phone format is Nigeria-only | Medium | `consumer.js` | `formatPhoneNumber()` only handles `0→234` prefix, unlike the contacts module which uses `libphonenumber-js`. |
| No message count enforcement | Medium | `publisher.js` | Subscription's `max_messages` is queried but never checked against actual usage. |
| No health check endpoints | Medium | `index.js` | No `/health` or `/ready` for container orchestration. |
| Plaintext API keys in DB | Low-Med | `vendor.js` | Keys are stored unhashed; a DB breach exposes all keys. |
| Session file sharing risk | Medium | Docker volume | Both API and Worker containers write to the same session directory. Potential file lock conflicts. |
| CORS hardcoded to localhost | Medium | `index.js` | Socket.IO CORS origin is `http://localhost:8080` — needs configuration for production. |
| No input size limits | Medium | `contacts.js` | Bulk contact insert has no limit on array size — could cause memory issues. |

---

*Generated: February 2026 · Project version: 1.0.0*
