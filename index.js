require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const pool = require('./src/config/db');

// Import routes
const vendorRoutes = require('./src/routes/vendor');
const userRoutes = require('./src/routes/users');
const whatsappNumberRoutes = require('./src/routes/whatsappNumbers');
const connectRoutes = require('./src/routes/connect');
const publisherRoutes = require('./src/routes/publisher');
const  contactRoutes = require('./src/routes/contacts');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:8080",
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
app.use(cors());
app.use(express.json());

// Mount routes
app.use('/api/vendors', vendorRoutes);
app.use('/api/users', userRoutes);
app.use('/api/whatsapp-numbers', whatsappNumberRoutes);
app.use('/api/connect', connectRoutes);
app.use('/api/messages', publisherRoutes);
app.use('/api/contacts', contactRoutes);

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
});