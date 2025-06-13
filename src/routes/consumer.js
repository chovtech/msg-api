require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const amqp = require('amqplib');
const db = require('../config/db');
const logger = require('../utils/logger');
const axios = require('axios');

const whatsappClients = new Map();

async function initWhatsAppClient(userId, sessionId) {
    // Return existing ready client if available
    if (whatsappClients.has(userId)) {
        const client = whatsappClients.get(userId);
        if (client.info) return client;
        throw new Error(`Client for user ${userId} exists but not ready`);
    }

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    whatsappClients.set(userId, client);

    // Wait for ready state with timeout
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Initialization timeout for user ${userId}`));
        }, 30000);

        client.once('ready', () => {
            clearTimeout(timeout);
            logger.info(`WhatsApp client ready for user ${userId}`);
            resolve();
        });

        client.once('auth_failure', (msg) => {
            clearTimeout(timeout);
            reject(new Error(`Authentication failed: ${msg}`));
        });

        client.initialize().catch(err => {
            clearTimeout(timeout);
            reject(err);
        });
    });

    return client;
}

function formatPhoneNumber(number) {
    const cleaned = number.replace(/\D/g, '');
    if (cleaned.startsWith('0')) return '234' + cleaned.slice(1);
    if (cleaned.startsWith('234')) return cleaned;
    return cleaned;
}

const mimeTypes = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/mpeg',
    document: 'application/pdf'
};

async function fetchMediaAsBase64(url) {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        return buffer.toString('base64');
    } catch (err) {
        throw new Error(`Failed to fetch media from ${url}: ${err.message}`);
    }
}

async function startConsumer() {
    try {
        // Initialize all WhatsApp clients at startup
        const [rows] = await db.query(`
            SELECT app_user_id, session_id 
            FROM whatsapp_numbers 
            WHERE is_active = 1
        `);

        logger.info(`Initializing ${rows.length} WhatsApp clients...`);

        // Initialize sequentially with retries
        for (const row of rows) {
            let retries = 3;
            while (retries > 0) {
                try {
                    await initWhatsAppClient(row.app_user_id, row.session_id);
                    logger.info(`✅ Client initialized for user ${row.app_user_id}`);
                    break;
                } catch (err) {
                    retries--;
                    if (retries === 0) {
                        logger.error(`❌ Failed after 3 attempts for user ${row.app_user_id}: ${err.message}`);
                    } else {
                        logger.warn(`⚠️ Retrying (${retries} left) for user ${row.app_user_id}: ${err.message}`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }
        }

        const connection = await amqp.connect(process.env.RABBITMQ_URL || 'amqp://localhost');
                const channel = await connection.createChannel();
        
                await channel.assertQueue('whatsapp_msg_queue', { durable: true });
                channel.prefetch(10);
        
                logger.info('RabbitMQ connected. Awaiting messages...');
        
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
        
                        const [rows] = await db.query(`
                            SELECT phone_number, session_id
                            FROM whatsapp_numbers
                            WHERE app_user_id = ? AND is_active = 1
                            LIMIT 1
                        `, [user_id]);
        
                        if (!rows.length) {
                            throw new Error(`No active WhatsApp number for user ${user_id}`);
                        }
        
                        const client = await initWhatsAppClient(user_id, rows[0].session_id);
                        const formattedNumber = formatPhoneNumber(number);
                        const recipient = `${formattedNumber}@c.us`;
        
                        const isRegistered = await client.isRegisteredUser(recipient);
                        if (!isRegistered) {
                            logger.warn(`Unregistered number: ${number}`);
                            await db.query(`
                                UPDATE sent_messages
                                SET status = 'failed', error_message = 'Not a WhatsApp number', sent_at = NOW()
                                WHERE batch_id = ? AND recipient = ?
                            `, [batch_id, number]);
                            return channel.ack(msg);
                        }
        
                        await db.query(`
                            UPDATE sent_messages
                            SET status = 'sent', sent_at = NOW()
                            WHERE batch_id = ? AND recipient = ? AND status = 'pending'
                        `, [batch_id, number]);
        
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
        
                        await db.query(`
                            UPDATE sent_messages
                            SET status = 'delivered', delivered_at = NOW()
                            WHERE batch_id = ? AND recipient = ?
                        `, [batch_id, number]);
        
                        logger.info(`✅ ${type.toUpperCase()} message delivered to ${number}`);
                        channel.ack(msg);
                    } catch (err) {
                        logger.error('❌ Error processing message:', err.message);
        
                        if (payload?.batch_id && payload?.number) {
                            await db.query(`
                                UPDATE sent_messages
                                SET status = 'failed', error_message = ?, sent_at = NOW()
                                WHERE batch_id = ? AND recipient = ?
                            `, [err.message, payload.batch_id, payload.number]);
                        }
        
                        channel.nack(msg, false, false);
                    }
                }, { noAck: false });
        
                process.on('SIGINT', async () => {
                    logger.info('Shutting down gracefully...');
                    await channel.close();
                    await connection.close();
                    
                    for (const [userId, client] of whatsappClients) {
                        try {
                            await client.destroy();
                            logger.info(`Closed WhatsApp client for user ${userId}`);
                        } catch (err) {
                            logger.error(`Error closing client ${userId}:`, err);
                        }
                    }
                    
                    process.exit(0);
                });
    } catch (err) {
        logger.error(`Consumer startup failed: ${err.message}`);
        setTimeout(startConsumer, 5000);
    }
}

startConsumer();