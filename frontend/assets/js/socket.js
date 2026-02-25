/**
 * Wamator Socket.IO Client Wrapper
 * Manages WebSocket connection for real-time events (QR codes, connection updates).
 */
const WamatorSocket = (() => {
  const SOCKET_URL = window.__WAMATOR_API_URL || 'http://localhost:3000';
  let socket = null;

  /** Connect to Socket.IO server */
  function connect() {
    if (socket && socket.connected) return socket;

    // io() is provided by Socket.IO client script (must be loaded before this file)
    socket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
      console.log('Socket.IO connected:', socket.id);
    });

    socket.on('disconnect', (reason) => {
      console.log('Socket.IO disconnected:', reason);
    });

    return socket;
  }

  /** Register user ID for targeted push events */
  function registerUser(userId) {
    if (!socket) connect();
    socket.emit('register_user', userId);
  }

  /** Listen for QR code generation events */
  function onQrGenerated(callback) {
    if (!socket) connect();
    socket.on('qr_generated', callback);
  }

  /** Listen for connection status updates */
  function onConnectionUpdate(callback) {
    if (!socket) connect();
    socket.on('connection_update', callback);
  }

  /** Remove all listeners and disconnect */
  function disconnect() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  }

  /** Get raw socket instance */
  function getSocket() {
    return socket;
  }

  return {
    connect,
    registerUser,
    onQrGenerated,
    onConnectionUpdate,
    disconnect,
    getSocket,
  };
})();
