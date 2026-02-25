# Wamator — Setup Guide

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 18+ | API runtime |
| npm | 9+ | Package management |
| MySQL | 8.0 | Database |
| RabbitMQ | 3.x | Message queue |
| Chromium / Google Chrome | Latest | WhatsApp Web automation (puppeteer) |
| Docker & Docker Compose | Latest | Optional — runs MySQL, RabbitMQ, and the API |

---

## 1. Local Development Setup (without Docker)

### 1.1 — Clone and install

```bash
git clone <your-repo-url> msg-api
cd msg-api
npm install
```

### 1.2 — Environment variables

Copy the example and edit:

```bash
cp .env.example .env
```

```env
NODE_ENV=development
PORT=3000

# Database
DB_HOST=localhost
DB_PORT=3306
DB_USER=wamator
DB_PASSWORD=wamator_pass_change_me
DB_NAME=whatsappapi

# RabbitMQ
RABBITMQ_URL=amqp://wamator:wamator_rmq_pass_change_me@localhost:5672

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:8080
```

- `FRONTEND_URL` is the origin of the static frontend. CORS and cookie security depend on it.
- When running locally, keep `NODE_ENV=development` so cookies are sent over plain HTTP.

### 1.3 — Set up MySQL

Make sure MySQL 8 is running, then create the database and user:

```sql
CREATE DATABASE IF NOT EXISTS whatsappapi
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_general_ci;

CREATE USER IF NOT EXISTS 'wamator'@'%'
  IDENTIFIED BY 'wamator_pass_change_me';

GRANT ALL PRIVILEGES ON whatsappapi.* TO 'wamator'@'%';
FLUSH PRIVILEGES;
```

Then run the schema (see [Section 4 — Database Schema](#4--database-schema) below), or import the SQL dump:

```bash
mysql -u wamator -p whatsappapi < schema.sql
```

### 1.4 — Set up RabbitMQ

Install and start RabbitMQ, then create the user:

```bash
# Ubuntu / Debian
sudo apt install rabbitmq-server
sudo systemctl start rabbitmq-server

# Create user matching .env
sudo rabbitmqctl add_user wamator wamator_rmq_pass_change_me
sudo rabbitmqctl set_permissions -p / wamator ".*" ".*" ".*"

# (Optional) Enable management UI at http://localhost:15672
sudo rabbitmq-plugins enable rabbitmq_management
sudo rabbitmqctl set_user_tags wamator management
```

### 1.5 — Start the API

```bash
npm run dev      # uses nodemon for auto-reload
# or
npm start        # plain node
```

The API runs at **http://localhost:3000**.

### 1.6 — Serve the frontend

The frontend is a set of static HTML files in the `frontend/` folder.
It must be served on the port that matches `FRONTEND_URL` (default `8080`).

Use any static file server:

```bash
# Option A — npx (no install)
npx serve frontend -l 8080

# Option B — Python
cd frontend && python3 -m http.server 8080

# Option C — Node http-server
npx http-server frontend -p 8080 -c-1
```

Open **http://localhost:8080** in your browser.

---

## 2. Docker Compose Setup (recommended)

This starts MySQL, RabbitMQ, phpMyAdmin, and the API in a single command.

### 2.1 — Build and start

```bash
docker compose up -d --build
```

Services started:

| Service | Container | Internal Port | Host Port |
|---------|-----------|---------------|-----------|
| MySQL 8 | wamator_mysql | 3306 | — (internal only) |
| phpMyAdmin | wamator_phpmyadmin | 80 | `127.0.0.1:9081` |
| RabbitMQ | wamator_rabbitmq | 5672 / 15672 | `127.0.0.1:15672` (management) |
| API | wamator_api | 3000 | `127.0.0.1:3000` |

### 2.2 — Import database schema

Open phpMyAdmin at **http://localhost:9081** (user: `wamator`, password: `wamator_pass_change_me`) and import the schema, or exec into the MySQL container:

```bash
docker exec -i wamator_mysql mysql -u wamator -pwamator_pass_change_me whatsappapi < schema.sql
```

### 2.3 — Serve the frontend

The Docker Compose file does **not** serve the frontend. You still need a static server:

```bash
npx serve frontend -l 8080
```

### 2.4 — Environment overrides

To change passwords or ports, edit `docker-compose.yml` directly — the API service reads environment variables from the `environment:` block, not from `.env`.

### 2.5 — Useful commands

```bash
docker compose logs -f api         # stream API logs
docker compose restart api         # restart after code changes
docker compose down                # stop all containers
docker compose down -v             # stop + delete data volumes
```

---

## 3. Testing Flow

Once the API (port 3000) and frontend (port 8080) are running:

### Step 1 — Sign Up

1. Open **http://localhost:8080**. You'll be redirected to the login page.
2. Click **Sign Up** and fill in: name, company name, email, phone number, password.
3. On success you are logged in automatically and redirected to the setup wizard.

### Step 2 — Setup Wizard (4 steps)

| Step | What it does |
|------|-------------|
| **Step 1** — Subscribe to a plan | The Free Plan is auto-assigned. You can pick another plan. |
| **Step 2** — Connect WhatsApp | Registers a WhatsApp phone number, then shows a QR code via Socket.IO. Scan it with the WhatsApp mobile app to authenticate. |
| **Step 3** — Import contacts | Add contacts one-by-one or paste a bulk list. |
| **Step 4** — Send a test message | Send a WhatsApp message to one of your contacts. |

### Step 3 — Dashboard

After setup you land on the dashboard at `/dashboard/`. From here you can:

- View stats (contacts count, messages sent, connected numbers)
- Manage contacts (`/dashboard/contacts.html`)
- View automation workflows (`/dashboard/automation.html`) — coming soon

### Sending messages via API

Once connected, you can also send messages programmatically:

```bash
curl -X POST http://localhost:3000/messages/send \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": 5,
    "contacts": [
      {"number": "2347063859559", "message": "Hello!"}
    ],
    "type": "text"
  }'
```

Your API key is in the `api_consumer` table (`api_key` column).

---

## 4. Database Schema

Create all tables in the `whatsappapi` database. Run these statements in order:

```sql
-- ──────────────────────────────────
-- api_consumer (vendor accounts)
-- ──────────────────────────────────
CREATE TABLE `api_consumer` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `company_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone_number` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `api_key` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  UNIQUE KEY `api_key` (`api_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- app_users
-- ──────────────────────────────────
CREATE TABLE `app_users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `api_consumer_id` int DEFAULT NULL,
  `external_user_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `company_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `api_consumer_id` (`api_consumer_id`),
  CONSTRAINT `app_users_ibfk_1` FOREIGN KEY (`api_consumer_id`) REFERENCES `api_consumer` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- plans
-- ──────────────────────────────────
CREATE TABLE `plans` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `max_phone_numbers` int DEFAULT NULL,
  `max_contacts` int DEFAULT NULL,
  `max_messages` int DEFAULT NULL,
  `max_automation` int DEFAULT NULL,
  `duration_days` int DEFAULT NULL,
  `features` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- plan_prices_by_country
-- ──────────────────────────────────
CREATE TABLE `plan_prices_by_country` (
  `id` int NOT NULL AUTO_INCREMENT,
  `plan_id` int DEFAULT NULL,
  `country_code` varchar(5) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `price` decimal(10,2) DEFAULT NULL,
  `currency` varchar(10) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `plan_id` (`plan_id`),
  CONSTRAINT `plan_prices_by_country_ibfk_1` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- subscriptions
-- ──────────────────────────────────
CREATE TABLE `subscriptions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `app_user_id` int NOT NULL,
  `plan_id` int NOT NULL,
  `started_at` datetime NOT NULL,
  `ends_at` datetime NOT NULL,
  `contacts_used` int DEFAULT '0',
  `messages_sent` int DEFAULT '0',
  `status` enum('active','expired') COLLATE utf8mb4_general_ci DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `plan_id` (`plan_id`),
  KEY `fk_subscriptions_user` (`app_user_id`),
  CONSTRAINT `fk_subscriptions_user` FOREIGN KEY (`app_user_id`) REFERENCES `app_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `subscriptions_ibfk_2` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- contact_lists
-- ──────────────────────────────────
CREATE TABLE `contact_lists` (
  `id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `api_consumer_id` int UNSIGNED NOT NULL,
  `app_user_id` int UNSIGNED NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone_number` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `email` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `gender` enum('male','female','other') COLLATE utf8mb4_general_ci DEFAULT NULL,
  `dob` date DEFAULT NULL,
  `age_group` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `language_preference` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `preferred_contact_time` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `nickname` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `custom_salutation` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `partner_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `anniversary_date` date DEFAULT NULL,
  `kids_names` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `number_of_kids` int DEFAULT NULL,
  `pets_names` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `job_title` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `company_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `industry` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `work_anniversary` date DEFAULT NULL,
  `state` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `city` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `country` varchar(100) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `address` text COLLATE utf8mb4_general_ci,
  `timezone` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `interests` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `preferred_products` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `last_contacted_at` datetime DEFAULT NULL,
  `message_opt_in` tinyint(1) DEFAULT '1',
  `whatsapp_broadcast_preference` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `last_purchase_date` date DEFAULT NULL,
  `average_spend` decimal(10,2) DEFAULT NULL,
  `customer_tier` enum('bronze','silver','gold','platinum','vip') COLLATE utf8mb4_general_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_contactlists_apiuser` (`api_consumer_id`,`app_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- whatsapp_numbers
-- ──────────────────────────────────
CREATE TABLE `whatsapp_numbers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `app_user_id` int DEFAULT NULL,
  `label` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone_number` varchar(20) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `session_id` text COLLATE utf8mb4_general_ci,
  `is_active` tinyint(1) DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_whatsapp_user` (`app_user_id`),
  CONSTRAINT `fk_whatsapp_numbers_app_user` FOREIGN KEY (`app_user_id`) REFERENCES `app_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- ──────────────────────────────────
-- sent_messages (partitioned by month)
-- ──────────────────────────────────
CREATE TABLE `sent_messages` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `batch_id` varchar(100) COLLATE utf8mb4_general_ci NOT NULL,
  `api_consumer_id` bigint NOT NULL,
  `app_user_id` bigint DEFAULT NULL,
  `recipient` text COLLATE utf8mb4_general_ci NOT NULL,
  `message` text COLLATE utf8mb4_general_ci NOT NULL,
  `channel` enum('sms','whatsapp','email') COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('pending','sent','failed','delivered') COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `message_type` varchar(20) COLLATE utf8mb4_general_ci DEFAULT 'text',
  `media_url` text COLLATE utf8mb4_general_ci,
  `error_message` text COLLATE utf8mb4_general_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sent_at` datetime DEFAULT NULL,
  `delivered_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`,`created_at`),
  KEY `idx_batch_id` (`batch_id`),
  KEY `idx_consumer_user` (`api_consumer_id`,`app_user_id`),
  KEY `idx_status_channel` (`status`,`channel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
PARTITION BY RANGE COLUMNS(created_at) (
  PARTITION p2025_01 VALUES LESS THAN ('2025-02-01'),
  PARTITION p2025_02 VALUES LESS THAN ('2025-03-01'),
  PARTITION p2025_03 VALUES LESS THAN ('2025-04-01'),
  PARTITION p2025_04 VALUES LESS THAN ('2025-05-01'),
  PARTITION p2025_05 VALUES LESS THAN ('2025-06-01'),
  PARTITION p2025_06 VALUES LESS THAN ('2025-07-01'),
  PARTITION p2025_07 VALUES LESS THAN ('2025-08-01'),
  PARTITION p2025_08 VALUES LESS THAN ('2025-09-01'),
  PARTITION p2025_09 VALUES LESS THAN ('2025-10-01'),
  PARTITION p2025_10 VALUES LESS THAN ('2025-11-01'),
  PARTITION p2025_11 VALUES LESS THAN ('2025-12-01'),
  PARTITION p2025_12 VALUES LESS THAN ('2026-01-01'),
  PARTITION p2026_01 VALUES LESS THAN ('2026-02-01'),
  PARTITION p2026_02 VALUES LESS THAN ('2026-03-01'),
  PARTITION p2026_03 VALUES LESS THAN ('2026-04-01'),
  PARTITION p2026_04 VALUES LESS THAN ('2026-05-01'),
  PARTITION p2026_05 VALUES LESS THAN ('2026-06-01'),
  PARTITION p2026_06 VALUES LESS THAN ('2026-07-01'),
  PARTITION p2026_07 VALUES LESS THAN ('2026-08-01'),
  PARTITION p2026_08 VALUES LESS THAN ('2026-09-01'),
  PARTITION p2026_09 VALUES LESS THAN ('2026-10-01'),
  PARTITION p2026_10 VALUES LESS THAN ('2026-11-01'),
  PARTITION p2026_11 VALUES LESS THAN ('2026-12-01'),
  PARTITION p2026_12 VALUES LESS THAN ('2027-01-01'),
  PARTITION pmax VALUES LESS THAN (MAXVALUE)
);

-- ──────────────────────────────────
-- Seed data: plans
-- ──────────────────────────────────
INSERT INTO `plans` (`id`, `name`, `max_phone_numbers`, `max_contacts`, `max_messages`, `max_automation`, `duration_days`, `features`) VALUES
(7,  'Free Plan',       1,  5,      200,    1, 0,   '{"automation": false, "analytics": false}'),
(8,  'Starter Plan',    3,  1000,   1000,   0, 30,  '{"automation": false, "analytics": false}'),
(9,  'Growth Plan',     2,  5000,   10000,  0, 30,  '{"automation": true, "analytics": true}'),
(10, 'Pro Plan',        5,  10000,  50000,  0, 30,  '{"automation": true, "analytics": true, "priority_support": true}'),
(11, 'Unlimited Plan',  0,  0,      0,      0, 30,  '{"automation": true, "analytics": true, "priority_support": true, "team_access": true}'),
(12, 'Annual Starter',  1,  1000,   12000,  0, 365, '{"automation": false, "analytics": false}'),
(13, 'Annual Pro',      5,  10000,  120000, 0, 365, '{"automation": true, "analytics": true, "priority_support": true, "team_access": true}');

-- ──────────────────────────────────
-- Seed data: plan prices
-- ──────────────────────────────────
INSERT INTO `plan_prices_by_country` (`plan_id`, `country_code`, `price`, `currency`) VALUES
(7,  'NG', 0.00,     'NGN'), (7,  'US', 0.00,     'USD'), (7,  'UK', 0.00,     'GBP'), (7,  'GH', 0.00,     'GHS'), (7,  'TZ', 0.00,     'TZS'),
(8,  'NG', 1000.00,  'NGN'), (8,  'US', 4.99,     'USD'), (8,  'UK', 3.99,     'GBP'), (8,  'GH', 60.00,    'GHS'), (8,  'TZ', 8000.00,  'TZS'),
(9,  'NG', 5000.00,  'NGN'), (9,  'US', 9.99,     'USD'), (9,  'UK', 8.99,     'GBP'), (9,  'GH', 250.00,   'GHS'), (9,  'TZ', 20000.00, 'TZS'),
(10, 'NG', 10000.00, 'NGN'), (10, 'US', 19.99,    'USD'), (10, 'UK', 17.99,    'GBP'), (10, 'GH', 500.00,   'GHS'), (10, 'TZ', 40000.00, 'TZS'),
(11, 'NG', 20000.00, 'NGN'), (11, 'US', 49.99,    'USD'), (11, 'UK', 44.99,    'GBP'), (11, 'GH', 1000.00,  'GHS'), (11, 'TZ', 80000.00, 'TZS'),
(12, 'NG', 10000.00, 'NGN'), (12, 'US', 49.99,    'USD'), (12, 'UK', 44.99,    'GBP'), (12, 'GH', 600.00,   'GHS'), (12, 'TZ', 50000.00, 'TZS'),
(13, 'NG', 50000.00, 'NGN'), (13, 'US', 199.99,   'USD'), (13, 'UK', 179.99,   'GBP'), (13, 'GH', 3000.00,  'GHS'), (13, 'TZ', 200000.00,'TZS');
```

---

## 5. Production Deployment

### 5.1 — Docker Compose

1. Clone the repo on your server.
2. Edit `docker-compose.yml` — change all passwords (`MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `RABBITMQ_DEFAULT_PASS`, `DB_PASSWORD`, `RABBITMQ_URL`).
3. Set `FRONTEND_URL` to your production frontend URL (e.g. `https://app.yourdomain.com`).
4. Run:

```bash
docker compose up -d --build
```

5. Import the database schema (Section 4).

### 5.2 — Nginx reverse proxy

Serve the frontend as static files and proxy API requests:

```nginx
server {
    listen 80;
    server_name app.yourdomain.com;

    # Frontend static files
    root /path/to/msg-api/frontend;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Proxy API requests
    location /vendors   { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /users     { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /whatsapp-numbers { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /connect   { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /messages  { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /contacts  { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
    location /session   { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }

    # Socket.IO
    location /socket.io {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

With this setup, both the frontend and API are on the same domain — set `FRONTEND_URL` in `docker-compose.yml` to `https://app.yourdomain.com` and update `window.__WAMATOR_API_URL` (or leave it unset so the frontend uses the same origin).

### 5.3 — SSL

Use Certbot for free SSL:

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d app.yourdomain.com
```

### 5.4 — Cookie security

When `NODE_ENV=production`, the session cookie (`wamator_api_key`) is set with `secure: true`, meaning it only works over HTTPS. Make sure your production setup uses SSL.

---

## 6. Troubleshooting

| Problem | Solution |
|---------|----------|
| `ECONNREFUSED` to MySQL | Check `DB_HOST` — use `mysql` inside Docker, `localhost` outside |
| `ECONNREFUSED` to RabbitMQ | Check `RABBITMQ_URL` — use `rabbitmq` as hostname inside Docker |
| CORS errors in browser | Ensure `FRONTEND_URL` matches the exact origin (protocol + host + port) |
| Cookie not sent | In dev, use `http://localhost:8080` (not `127.0.0.1`). In prod, use HTTPS |
| QR code not appearing | Check that Socket.IO connects — open browser DevTools Network → WS tab |
| Chromium not found | Inside Docker the Dockerfile installs deps. Outside Docker, install `chromium-browser` or set `PUPPETEER_EXECUTABLE_PATH` |
| `shm_size` error | Docker needs `shm_size: 256mb` for Chromium — already set in `docker-compose.yml` |
