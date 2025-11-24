import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import mongoose from "mongoose";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import Session from "./models/Session.js";

// Load config.env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "config.env") });

// Get configuration from environment variables
const PORT = Number(process.env.VITE_SOCKET_PORT ?? process.env.PORT ?? 4000);
const CODE_LENGTH = Number(process.env.CONNECTION_CODE_LENGTH ?? 6);
const CODE_CHARS =
  process.env.CONNECTION_CODE_CHARS ?? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NODE_ENV = process.env.NODE_ENV ?? "production";
const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://localhost:27017/toolzbuy";
const MAX_NAME_LENGTH = 32;

// Initialize Express app
const app = express();

// Middleware
app.use(
  cors({
    origin:
      NODE_ENV === "production"
        ? process.env.CORS_ORIGIN?.split(",") || "*"
        : "*",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API endpoint to get server configuration
app.get("/api/config", (req, res) => {
  res.json({
    codeLength: CODE_LENGTH,
    codeChars: CODE_CHARS.length,
  });
});

// Create HTTP server
const httpServer = createServer(app);

// Initialize Socket.IO
const io = new Server(httpServer, {
  cors: {
    origin:
      NODE_ENV === "production"
        ? process.env.CORS_ORIGIN?.split(",") || "*"
        : "*",
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Generate a random connection code using environment variables
async function generateConnectionCode() {
  let code = "";
  let attempts = 0;
  const maxAttempts = 100;
  let isUnique = false;

  while (!isUnique && attempts < maxAttempts) {
    code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }

    // Check if code exists in MongoDB
    const existingSession = await Session.findOne({ code });
    if (!existingSession) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique) {
    throw new Error("Failed to generate unique connection code");
  }

  return code;
}

function createDefaultName(socketId = "") {
  return `User ${socketId.slice(-4) || "0000"}`;
}

function sanitizeDisplayName(raw, fallback = "") {
  if (typeof raw !== "string") {
    return fallback;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, MAX_NAME_LENGTH);
}

function resolveClientId(raw) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length >= 8) {
      return trimmed;
    }
  }
  return randomUUID();
}

// Helper function to get room info
function getRoomInfo(sessionCode) {
  const room = io.sockets.adapter.rooms.get(sessionCode);
  return {
    exists: !!room,
    size: room ? room.size : 0,
    sockets: room ? Array.from(room) : [],
  };
}

// Helper function to notify all users in a room
function notifyRoomUsers(sessionCode, event, data) {
  const roomInfo = getRoomInfo(sessionCode);
  if (roomInfo.exists && roomInfo.size > 0) {
    io.to(sessionCode).emit(event, data);

    // Also send individually to ensure delivery
    roomInfo.sockets.forEach((socketId) => {
      const socketInRoom = io.sockets.sockets.get(socketId);
      if (socketInRoom) {
        socketInRoom.emit(event, data);
      }
    });
  }
}

// Socket.IO connection handling
io.on("connection", (socket) => {
  let currentSession = null;

  console.log(`Client connected: ${socket.id}`);

  const clientId = resolveClientId(socket.handshake.auth?.clientId);
  socket.data.clientId = clientId;
  const initialName = sanitizeDisplayName(
    socket.handshake.auth?.name,
    createDefaultName(socket.id)
  );
  socket.data.displayName = initialName;
  socket.emit("self:info", {
    socketId: socket.id,
    clientId,
    name: initialName,
  });

  // Send code configuration to client on connection
  socket.emit("code:config", { length: CODE_LENGTH });

  // Handle joining a room with connection code
  socket.on("join:session", async (code) => {
    try {
      if (typeof code !== "string" || code.length !== CODE_LENGTH) {
        socket.emit(
          "join:error",
          `Invalid connection code. Must be ${CODE_LENGTH} characters.`
        );
        return;
      }

      const sessionCode = code.toUpperCase().trim();

      // Find session in MongoDB
      const session = await Session.findOne({
        code: sessionCode,
        isActive: true,
      });

      if (!session) {
        socket.emit("join:error", "Session not found or inactive.");
        return;
      }

      // Leave previous room if any
      if (currentSession) {
        socket.leave(currentSession);
      }

      // Add or update user entry in MongoDB
      const updatedSession = await session.addOrUpdateUser(
        socket.data.clientId,
        socket.id,
        socket.data.displayName
      );

      // Join new room
      socket.join(sessionCode);
      currentSession = sessionCode;

      // Send current room content to the new user
      socket.emit("content:sync", updatedSession.content || "");
      socket.emit("join:success", sessionCode);

      console.log(`Socket ${socket.id} joined session: ${sessionCode}`);

      const participants = updatedSession.getParticipants();

      // Check current room size from Socket.IO
      const roomInfo = getRoomInfo(sessionCode);
      const totalUsers = roomInfo.size;

      // Only show typing pad when BOTH users are connected (roomSize >= 2)
      if (totalUsers >= 2) {
        console.log(
          `Session ${sessionCode} now has ${totalUsers} users, showing typing pad to all...`
        );

        // Notify ALL users in the room (including creator) to show typing pad
        notifyRoomUsers(sessionCode, "user:joined", {
          roomSize: totalUsers,
          code: sessionCode,
          showPad: true, // Signal to show typing pad
          participants,
        });
      } else {
        // If only one user, don't show typing pad
        socket.emit("waiting:for:user", {
          code: sessionCode,
          roomSize: totalUsers,
          participants,
        });
      }
    } catch (error) {
      console.error("Error in join:session:", error);
      socket.emit("join:error", "Failed to join session. Please try again.");
    }
  });

  // Handle creating a new room
  socket.on("create:session", async () => {
    try {
      const newCode = await generateConnectionCode();

      // Leave previous room if any
      if (currentSession) {
        socket.leave(currentSession);
      }

      // Create session in MongoDB
      const session = new Session({
        code: newCode,
        content: "",
        creatorSocketId: socket.id,
        creatorClientId: socket.data.clientId,
        creatorName: socket.data.displayName,
        joinedUsers: [],
        isActive: true,
      });

      await session.save();

      socket.join(newCode);
      currentSession = newCode;

      socket.emit("join:success", newCode);
      socket.emit("content:sync", "");

      // Don't show typing pad yet - wait for both users to connect
      // Only show code, not typing pad
      const participants = session.getParticipants();

      socket.emit("session:created", {
        code: newCode,
        roomSize: 1,
        waitingForUser: true,
        participants,
      });

      console.log(`Socket ${socket.id} created session: ${newCode}`);
    } catch (error) {
      console.error("Error in create:session:", error);
      socket.emit("join:error", "Failed to create session. Please try again.");
    }
  });

  // Handle content updates
  socket.on("content:update", async (nextValue) => {
    try {
      if (typeof nextValue !== "string" || !currentSession) return;

      // Limit content size (optional - 1MB limit)
      const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
      if (nextValue.length > MAX_CONTENT_SIZE) {
        socket.emit("content:error", "Content too large. Maximum size is 1MB.");
        return;
      }

      // Update content in MongoDB
      const session = await Session.findOne({ code: currentSession });
      if (session) {
        session.content = nextValue;
        session.lastActivity = new Date();
        await session.save();
      }

      // Broadcast to other users in the room
      socket.to(currentSession).emit("content:sync", nextValue);
    } catch (error) {
      console.error("Error in content:update:", error);
    }
  });

  // Handle typing indicator
  socket.on("typing", (isTyping) => {
    try {
      if (currentSession) {
        socket.to(currentSession).emit("typing", Boolean(isTyping));
      }
    } catch (error) {
      console.error("Error in typing:", error);
    }
  });

  socket.on("user:updateName", async (nextName = "", callback = () => {}) => {
    try {
      if (!currentSession) {
        callback({ ok: false, error: "Not in a session" });
        return;
      }

      const cleanName = sanitizeDisplayName(
        nextName,
        socket.data.displayName || createDefaultName(socket.id)
      );
      socket.data.displayName = cleanName;

      const session = await Session.findOne({
        code: currentSession,
        isActive: true,
      });
      if (!session) {
        callback({ ok: false, error: "Session not found" });
        return;
      }

      await session.updateUserName(socket.data.clientId, cleanName);
      const participants = session.getParticipants();
      notifyRoomUsers(currentSession, "participants:update", { participants });

      callback({ ok: true, name: cleanName });
    } catch (error) {
      console.error("Error in user:updateName:", error);
      callback({ ok: false, error: "Unable to update name" });
    }
  });

  // Handle leaving a session
  socket.on("leave:session", async () => {
    try {
      if (currentSession) {
        console.log(`Socket ${socket.id} leaving session: ${currentSession}`);

        // Update MongoDB
        const session = await Session.findOne({ code: currentSession });
        if (session) {
          await session.removeUserByClientId(socket.data.clientId);
          const participants = session.getParticipants();
          notifyRoomUsers(currentSession, "participants:update", {
            participants,
          });
        }

        socket.leave(currentSession);
        currentSession = null;
      }
    } catch (error) {
      console.error("Error in leave:session:", error);
    }
  });

  // Handle disconnection
  socket.on("disconnect", async (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);

    if (currentSession) {
      socket.leave(currentSession);
    }
  });

  // Error handling
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// API endpoint to get session stats
app.get("/api/stats", async (req, res) => {
  try {
    const activeSessions = await Session.find({ isActive: true });
    const stats = {
      activeSessions: activeSessions.length,
      totalConnections: io.sockets.sockets.size,
      sessions: activeSessions.map((session) => ({
        code: session.code,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        roomSize: session.getTotalUsers(),
        hasBothUsers: session.hasBothUsers(),
      })),
    };
    res.json(stats);
  } catch (error) {
    console.error("Error getting stats:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");

    // Start server after MongoDB connection
    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📡 Socket.IO server ready`);
      console.log(`🔧 Code length: ${CODE_LENGTH}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`💾 MongoDB: connected`);
    });
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully...");
  httpServer.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
