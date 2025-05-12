// server.js

// Load environment variables from .env in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express    = require('express');
const http       = require('http');
const multer     = require('multer');
const { google } = require('googleapis');
const { PassThrough } = require('stream');
const { v4: uuidv4 }  = require('uuid');
const mongoose   = require('mongoose');
const socketIO   = require('socket.io');
const cors       = require('cors');
const webpush    = require('web-push');                      // ← added

const app    = express();
const server = http.createServer(app);

// ---------------------------
// Config & Environment
// ---------------------------
const {
  MONGODB_URI,
  PORT = 5002,
  BASE_URL = `http://localhost:${PORT}`,
  CLIENT_URL = 'http://localhost:3000',
  GOOGLE_DRIVE_FOLDER_ID,
  VAPID_PUBLIC_KEY,           // ← added
  VAPID_PRIVATE_KEY           // ← added
} = process.env;

if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI environment variable is required');
  process.exit(1);
}
if (!GOOGLE_DRIVE_FOLDER_ID) {
  console.error('Error: GOOGLE_DRIVE_FOLDER_ID environment variable is required');
  process.exit(1);
}
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('Error: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required for Push Notifications');
  process.exit(1);
}

// Initialize web-push with your VAPID keys
webpush.setVapidDetails(
  'mailto:you@yourdomain.com',  // ← change to your contact email
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ---------------------------
// Middleware
// ---------------------------
app.use(express.json());
app.use(cors({ origin: CLIENT_URL }));

// ---------------------------
// Socket.IO Setup with CORS
// ---------------------------
const io = socketIO(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST']
  }
});

// ---------------------------
// Connect to MongoDB
// ---------------------------
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('MongoDB connected'));

// ---------------------------
// Mongoose Schemas & Models
// ---------------------------
const chatSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const ChatSession = mongoose.model('ChatSession', chatSessionSchema);

const messageSchema = new mongoose.Schema({
  sessionId: { type: String, required: true },
  sender:    { type: String, required: true },
  text:      { type: String, default: '' },
  fileUrl:   { type: String, default: '' },
  fileType:  { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

const userSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  email:       { type: String, required: true },
  companyName: { type: String, required: true },
  link:        { type: String, required: true },
  createdAt:   { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Subscription model to store PushSubscription objects
const subscriptionSchema = new mongoose.Schema({
  endpoint:  { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth:   { type: String, required: true }
  },
  sessionId: { type: String, required: true }
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

// ---------------------------
// Google Drive Client Setup
// ---------------------------
const serviceAccount = require('./service-account.json');
const auth           = google.auth.fromJSON(serviceAccount);
auth.scopes = ['https://www.googleapis.com/auth/drive'];
const drive = google.drive({ version: 'v3', auth });

// ---------------------------
// File Upload Setup with Multer
// ---------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 }, // 100 KB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images and audio files are allowed.'));
    }
  }
});

// ---------------------------
// API Endpoints
// ---------------------------

// Upload endpoint → Google Drive
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file provided or file too large.' });
  }

  try {
    const bufferStream = new PassThrough();
    bufferStream.end(req.file.buffer);

    const driveRes = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [GOOGLE_DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream
      }
    });
    const fileId = driveRes.data.id;

    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    const meta = await drive.files.get({
      fileId,
      fields: 'webContentLink'
    });

    res.json({ fileUrl: meta.data.webContentLink });
  } catch (err) {
    console.error('Google Drive upload error:', err);
    res.status(500).json({ error: err.message || 'Upload to Google Drive failed.' });
  }
});

// Save PushSubscription
app.post('/api/save-subscription', async (req, res) => {
  const sub = req.body;
  if (!sub.endpoint || !sub.keys) {
    return res.status(400).json({ error: 'Invalid subscription payload.' });
  }

  try {
    // Expect front-end to include a sessionId property on sub
    const sessionId = sub.sessionId;
    await Subscription.findOneAndUpdate(
      { endpoint: sub.endpoint },
      { endpoint: sub.endpoint, keys: sub.keys, sessionId },
      { upsert: true, new: true }
    );
    res.sendStatus(201);
  } catch (err) {
    console.error('Saving subscription failed', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// Create chat session
app.post('/api/create-chat', async (req, res) => {
  try {
    const sessionId  = uuidv4();
    const newSession = new ChatSession({ sessionId });
    await newSession.save();
    res.json({ sessionId });
  } catch (error) {
    console.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Could not create chat session' });
  }
});

// List chat sessions
app.get('/api/chat-sessions', async (req, res) => {
  try {
    const sessions = await ChatSession.find().sort({ createdAt: -1 });
    res.json(sessions);
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    res.status(500).json({ error: 'Could not fetch chat sessions' });
  }
});

// Get messages by session
app.get('/api/messages/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const messages = await Message.find({ sessionId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Create user
app.post('/api/create-user', async (req, res) => {
  try {
    const { name, email, companyName } = req.body;
    const sessionId  = uuidv4();
    await new ChatSession({ sessionId }).save();

    const link = `${CLIENT_URL}/chat/${sessionId}`;
    const newUser = new User({ name, email, companyName, link });
    await newUser.save();

    io.emit('newUser', newUser);
    res.json(newUser);
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Could not create user' });
  }
});

// List users
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Could not fetch users' });
  }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.sendStatus(204);
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ---------------------------
// Socket.IO Configuration
// ---------------------------
io.on('connection', socket => {
  console.log('New client connected');

  socket.on('joinSession', sessionId => {
    socket.join(sessionId);
    console.log(`Client joined session: ${sessionId}`);
  });

  socket.on('chatMessage', async ({ sessionId, sender, text, fileUrl, fileType }) => {
    const messageData = { sessionId, sender, text, fileUrl, fileType };
    try {
      await new Message(messageData).save();
    } catch (error) {
      console.error('Error saving message:', error);
    }

    // 1⃣ in-app broadcast
    io.to(sessionId).emit('chatMessage', messageData);

    // 2⃣ device/browser Push notifications
    try {
      const subs = await Subscription.find({ sessionId });
      const payload = JSON.stringify({
        title: `New message from ${sender}`,
        body: text?.slice(0, 100) || 'Sent an attachment',
        icon: fileType?.startsWith('image/') ? fileUrl : undefined,
        url: `${BASE_URL}/chat/${sessionId}`
      });
      subs.forEach(sub => {
        webpush.sendNotification(sub, payload).catch(err => {
          if (err.statusCode === 410 || err.statusCode === 404) {
            // cleanup expired subscriptions
            Subscription.deleteOne({ endpoint: sub.endpoint }).catch(console.error);
          } else {
            console.error('Push error:', err);
          }
        });
      });
    } catch (err) {
      console.error('Error sending push notifications:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// ---------------------------
// Start Server
// ---------------------------
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
