const amqp = require('amqplib');

const connect = async () => {
  try {
    const connection = await amqp.connect('amqp://localhost');
    const channel = await connection.createChannel();
    await channel.assertQueue('whatsapp_msg_queue');
    return channel;
  } catch (err) {
    console.error('RabbitMQ connection failed:', err);
    throw err;
  }
};

module.exports = connect;
