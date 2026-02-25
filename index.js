require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const http = require('http');
const socketIo = require('socket.io');
const pool = require('./src/config/db');
const amqp = require('amqplib');
const axios = require('axios');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const formatPhoneNumber = require('./src/utils/formatPhoneNumber');
const logger = require('./src/utils/logger');

// Import routes
const vendorRoutes = require('./src/routes/vendor');
const userRoutes = require('./src/routes/users');
const whatsappNumberRoutes = require('./src/routes/whatsappNumbers');
const connectRoutes = require('./src/routes/connect');
const { clients } = require('./src/routes/connect');
const publisherRoutes = require('./src/routes/publisher');
const  contactRoutes = require('./src/routes/contacts');
const sessionRoutes = require('./src/routes/session');

const app = express();
const server = http.createServer(app);

// Allowed origins for CORS (must be defined before Socket.IO and Express CORS)
const allowedOrigins = [
  'http://localhost:8080',
  process.env.FRONTEND_URL,
].filter(Boolean);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Track active connections
const activeConnections = {};

io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  socket.on('register_user', (userId) => {
    activeConnections[userId] = socket.id;
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    for (const [userId, socketId] of Object.entries(activeConnections)) {
      if (socketId === socket.id) {
        delete activeConnections[userId];
        break;
      }
    }
  });
});

// Make io available to routes
app.set('io', io);
app.set('activeConnections', activeConnections);

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json());

// Mount routes
app.use('/vendors', vendorRoutes);
app.use('/users', userRoutes);
app.use('/whatsapp-numbers', whatsappNumberRoutes);
app.use('/connect', connectRoutes);
app.use('/messages', publisherRoutes);
app.use('/contacts', contactRoutes);
app.use('/session', sessionRoutes);

// Test route
app.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT NOW() as now');
    res.json({ message: 'API running', dbTime: rows[0].now });
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ error: 'DB connection failed' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO available at ws://localhost:${PORT}`);

  // Auto-reconnect saved sessions, then start consuming messages
  reconnectSessions().then(() => {
    // Give sessions a few seconds to reach READY before consuming
    setTimeout(() => startConsumer(), 5000);
  });
});

// ─────────────────────────────────────────────
// MIME types for media messages
// ─────────────────────────────────────────────
const mimeTypes = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  document: 'application/pdf'
};

// ─────────────────────────────────────────────
// Fetch media from URL and return base64
// ─────────────────────────────────────────────
async function fetchMediaAsBase64(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data).toString('base64');
}

// ─────────────────────────────────────────────
// Auto-reconnect WhatsApp sessions on startup
// Queries DB for active sessions and re-initializes
// clients from persisted LocalAuth data
// ─────────────────────────────────────────────
async function reconnectSessions() {
  try {
    const [rows] = await pool.query(
      `SELECT app_user_id, phone_number, session_id
       FROM whatsapp_numbers
       WHERE is_active = 1 AND session_id IS NOT NULL`
    );

    if (rows.length === 0) {
      logger.info('No active sessions to reconnect.');
      return;
    }

    logger.info(`Reconnecting ${rows.length} saved WhatsApp session(s)...`);

    for (const row of rows) {
      const sessionId = row.session_id;

      // Skip if already in memory (shouldn't happen on fresh boot, but safe)
      if (clients[sessionId]) {
        logger.info(`Session ${sessionId} already in memory — skipping.`);
        continue;
      }

      try {
        const client = new Client({
          authStrategy: new LocalAuth({
            clientId: sessionId,
            dataPath: '/app/.wwebjs_auth',
          }),
          puppeteer: {
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--disable-gpu',
              '--no-first-run',
              '--no-zygote',
              '--single-process',
            ],
          },
        });

        // Store immediately so consumer can pick it up once ready
        clients[sessionId] = client;

        client.on('ready', () => {
          logger.info(`[RECONNECT ✅] Session ${sessionId} is READY`);
        });

        client.on('disconnected', async (reason) => {
          logger.warn(`[RECONNECT ❌] Session ${sessionId} disconnected: ${reason}`);
          delete clients[sessionId];
          try {
            await pool.query(
              `UPDATE whatsapp_numbers SET is_active = 0, session_id = NULL
               WHERE app_user_id = ? AND phone_number = ?`,
              [row.app_user_id, row.phone_number]
            );
          } catch (dbErr) {
            logger.error(`[RECONNECT DB] Failed to update after disconnect: ${dbErr.message}`);
          }
        });

        client.on('auth_failure', async (msg) => {
          logger.error(`[RECONNECT AUTH_FAILURE] Session ${sessionId}: ${msg}`);
          delete clients[sessionId];
          try {
            await pool.query(
              `UPDATE whatsapp_numbers SET is_active = 0, session_id = NULL
               WHERE app_user_id = ? AND phone_number = ?`,
              [row.app_user_id, row.phone_number]
            );
          } catch (dbErr) {
            logger.error(`[RECONNECT DB] Failed to update after auth_failure: ${dbErr.message}`);
          }
        });

        client.initialize();
        logger.info(`[RECONNECT] Initializing session ${sessionId}...`);

        // Stagger initialization — 3s between clients to avoid Chromium overload
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (initErr) {
        logger.error(`[RECONNECT] Failed to init session ${sessionId}: ${initErr.message}`);
        delete clients[sessionId];
      }
    }

    logger.info('Session reconnection phase complete.');
  } catch (err) {
    logger.error(`[RECONNECT] Failed to query active sessions: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// RabbitMQ consumer — runs inside the API process
// Reuses WhatsApp clients from connect.js (single
// Chromium owner per session, no lock conflicts)
// ─────────────────────────────────────────────
async function startConsumer() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost';
    const connection = await amqp.connect(rabbitmqUrl);
    const channel = await connection.createChannel();

    await channel.assertQueue('whatsapp_msg_queue', { durable: true });
    channel.prefetch(10);

    logger.info('RabbitMQ connected. Awaiting messages...');

    // Reconnect on connection error
    connection.on('error', (err) => {
      logger.error(`RabbitMQ connection error: ${err.message}`);
    });
    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed. Reconnecting in 5s...');
      setTimeout(() => startConsumer(), 5000);
    });

    channel.consume('whatsapp_msg_queue', async (msg) => {
      if (!msg) return;

      let payload;
      try {
        payload = JSON.parse(msg.content.toString());
        const {
          batch_id,
          number,
          message,
          user_id,
          type = 'text',
          media_url,
          media_filename,
          api_consumer_id,
          metadata = {}
        } = payload;

        logger.info(`Processing ${type} message to ${number} [Batch: ${batch_id}]`);

        // 1. Look up the active WhatsApp session for this user
        const [rows] = await pool.query(
          `SELECT phone_number, session_id
           FROM whatsapp_numbers
           WHERE app_user_id = ? AND is_active = 1
           LIMIT 1`,
          [user_id]
        );

        if (!rows.length) {
          throw new Error(`No active WhatsApp number for user ${user_id}`);
        }

        const sessionId = rows[0].session_id;

        // 2. Get the in-memory client (owned by this process)
        const client = clients[sessionId];
        if (!client || !client.info) {
          throw new Error(`WhatsApp client not ready for session ${sessionId} (user ${user_id})`);
        }

        // 3. Format recipient number (E.164 without +, via libphonenumber-js)
        const formattedNumber = formatPhoneNumber(number);
        if (!formattedNumber) {
          throw new Error(`Invalid phone number: ${number}`);
        }
        const recipient = `${formattedNumber}@c.us`;

        // 4. Check if recipient is on WhatsApp
        const isRegistered = await client.isRegisteredUser(recipient);
        if (!isRegistered) {
          logger.warn(`Unregistered number: ${number}`);
          await pool.query(
            `UPDATE sent_messages
             SET status = 'failed', error_message = 'Not a WhatsApp number', sent_at = NOW()
             WHERE batch_id = ? AND recipient = ?`,
            [batch_id, number]
          );
          return channel.ack(msg);
        }

        // 5. Send the message
        if (type === 'text') {
          await client.sendMessage(recipient, message);
        } else {
          if (!media_url || !media_filename) {
            throw new Error('Missing media_url or media_filename for media message');
          }
          const base64Data = await fetchMediaAsBase64(media_url);
          const media = new MessageMedia(
            mimeTypes[type] || 'application/octet-stream',
            base64Data,
            media_filename
          );
          await client.sendMessage(recipient, media, { caption: message || '' });
        }

        // 6. Mark as delivered
        await pool.query(
          `UPDATE sent_messages
           SET status = 'delivered', delivered_at = NOW()
           WHERE batch_id = ? AND recipient = ? AND status = 'pending'`,
          [batch_id, number]
        );

        logger.info(`✅ ${type.toUpperCase()} message delivered to ${number}`);
        channel.ack(msg);
      } catch (err) {
        logger.error(`❌ Error processing message: ${err.message}`);

        if (payload?.batch_id && payload?.number) {
          try {
            await pool.query(
              `UPDATE sent_messages
               SET status = 'failed', error_message = ?, sent_at = NOW()
               WHERE batch_id = ? AND recipient = ?`,
              [err.message, payload.batch_id, payload.number]
            );
          } catch (dbErr) {
            logger.error(`DB update failed after message error: ${dbErr.message}`);
          }
        }

        channel.nack(msg, false, false);
      }
    }, { noAck: false });

  } catch (err) {
    logger.error(`Consumer startup failed: ${err.message}. Retrying in 5s...`);
    setTimeout(() => startConsumer(), 5000);
  }
}
