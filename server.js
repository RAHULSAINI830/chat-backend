// server.js

// Load environment variables from .env in development
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express    = require('express');
const http       = require('http');
const multer     = require('multer');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const mongoose   = require('mongoose');
const socketIO   = require('socket.io');
const cors       = require('cors');

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
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_DRIVE_FOLDER_ID
} = process.env;

if (!MONGODB_URI) {
  console.error('Error: MONGODB_URI environment variable is required');
  process.exit(1);
}
if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY || !GOOGLE_DRIVE_FOLDER_ID) {
  console.error('Error: Google Drive env vars (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_DRIVE_FOLDER_ID) are required');
  process.exit(1);
}

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

// ---------------------------
// Google Drive Client Setup
// ---------------------------
const auth = new google.auth.JWT(
  GOOGLE_CLIENT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/drive']
);
const drive = google.drive({ version: 'v3', auth });

// ---------------------------
// File Upload Setup with Multer (memoryStorage)
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
    // 1) Upload to Drive
    const driveRes = await drive.files.create({
      requestBody: {
        name: req.file.originalname,
        parents: [GOOGLE_DRIVE_FOLDER_ID]
      },
      media: {
        mimeType: req.file.mimetype,
        body: Buffer.from(req.file.buffer)
      }
    });
    const fileId = driveRes.data.id;

    // 2) Make the file publicly readable
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    // 3) Retrieve the direct download link
    const meta = await drive.files.get({
      fileId,
      fields: 'webContentLink'
    });

    res.json({ fileUrl: meta.data.webContentLink });
  } catch (err) {
    console.error('Google Drive upload error:', err);
    res.status(500).json({ error: 'Upload to Google Drive failed.' });
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
    const messages      = await Message.find({ sessionId }).sort({ createdAt: 1 });
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

    // 1) Generate a chat sessionId & save it
    const sessionId  = uuidv4();
    const newSession = new ChatSession({ sessionId });
    await newSession.save();

    // 2) Build the link using that sessionId
    const link = `${CLIENT_URL}/chat/${sessionId}`;

    // 3) Save the user record, including their chat link
    const newUser = new User({ name, email, companyName, link });
    await newUser.save();

    // 4) Notify admins in real-time of new user
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
    const newMessage  = new Message(messageData);
    try {
      await newMessage.save();
    } catch (error) {
      console.error('Error saving message:', error);
    }
    io.to(sessionId).emit('chatMessage', messageData);
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
