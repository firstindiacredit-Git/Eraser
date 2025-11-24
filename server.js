import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load config.env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, "config.env") });

// Get configuration from environment variables
const PORT = Number(process.env.VITE_SOCKET_PORT ?? process.env.PORT ?? 4000);
const CODE_LENGTH = Number(process.env.CONNECTION_CODE_LENGTH ?? 6);
const CODE_CHARS =
  process.env.CONNECTION_CODE_CHARS ?? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NODE_ENV = process.env.NODE_ENV ?? "development";

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

// Store content per room (connection code)
const sessionContent = new Map();

// Store active sessions info
const activeSessions = new Map();

// Generate a random connection code using environment variables
function generateConnectionCode() {
  let code = "";
  let attempts = 0;
  const maxAttempts = 100;

  do {
    code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
    attempts++;
  } while (activeSessions.has(code) && attempts < maxAttempts);

  if (attempts >= maxAttempts) {
    throw new Error("Failed to generate unique connection code");
  }

  return code;
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

  // Send code configuration to client on connection
  socket.emit("code:config", { length: CODE_LENGTH });

  // Handle joining a room with connection code
  socket.on("join:session", (code) => {
    try {
      if (typeof code !== "string" || code.length !== CODE_LENGTH) {
        socket.emit(
          "join:error",
          `Invalid connection code. Must be ${CODE_LENGTH} characters.`
        );
        return;
      }

      const sessionCode = code.toUpperCase().trim();

      // Leave previous room if any
      if (currentSession) {
        socket.leave(currentSession);
      }

      // Join new room
      socket.join(sessionCode);
      currentSession = sessionCode;

      // Initialize room content if it doesn't exist
      if (!sessionContent.has(sessionCode)) {
        sessionContent.set(sessionCode, "");
        activeSessions.set(sessionCode, {
          createdAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        });
      }

      // Update session activity
      const sessionInfo = activeSessions.get(sessionCode);
      if (sessionInfo) {
        sessionInfo.lastActivity = new Date().toISOString();
      }

      // Send current room content to the new user
      socket.emit("content:sync", sessionContent.get(sessionCode));
      socket.emit("join:success", sessionCode);

      console.log(`Socket ${socket.id} joined session: ${sessionCode}`);

      // Get room size AFTER joining to ensure accurate count
      setTimeout(() => {
        const roomInfo = getRoomInfo(sessionCode);
        const roomSize = roomInfo.size;

        // Notify ALL users in the room (including creator) that someone joined
        if (roomSize > 1) {
          console.log(
            `Session ${sessionCode} now has ${roomSize} users, notifying all...`
          );

          notifyRoomUsers(sessionCode, "user:joined", {
            roomSize,
            code: sessionCode,
          });
        }
      }, 200);
    } catch (error) {
      console.error("Error in join:session:", error);
      socket.emit("join:error", "Failed to join session. Please try again.");
    }
  });

  // Handle creating a new room
  socket.on("create:session", () => {
    try {
      const newCode = generateConnectionCode();

      // Leave previous room if any
      if (currentSession) {
        socket.leave(currentSession);
      }

      // Initialize new room
      sessionContent.set(newCode, "");
      activeSessions.set(newCode, {
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      });
      socket.join(newCode);
      currentSession = newCode;

      socket.emit("join:success", newCode);
      socket.emit("content:sync", "");

      console.log(`Socket ${socket.id} created session: ${newCode}`);
    } catch (error) {
      console.error("Error in create:session:", error);
      socket.emit("join:error", "Failed to create session. Please try again.");
    }
  });

  // Handle content updates
  socket.on("content:update", (nextValue) => {
    try {
      if (typeof nextValue !== "string" || !currentSession) return;

      // Limit content size (optional - 1MB limit)
      const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
      if (nextValue.length > MAX_CONTENT_SIZE) {
        socket.emit("content:error", "Content too large. Maximum size is 1MB.");
        return;
      }

      sessionContent.set(currentSession, nextValue);

      // Update session activity
      const sessionInfo = activeSessions.get(currentSession);
      if (sessionInfo) {
        sessionInfo.lastActivity = new Date().toISOString();
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

  // Handle leaving a session
  socket.on("leave:session", () => {
    try {
      if (currentSession) {
        console.log(`Socket ${socket.id} leaving session: ${currentSession}`);
        socket.leave(currentSession);
        currentSession = null;
      }
    } catch (error) {
      console.error("Error in leave:session:", error);
    }
  });

  // Handle disconnection
  socket.on("disconnect", (reason) => {
    console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);

    if (currentSession) {
      socket.leave(currentSession);

      // Check if room is empty and cleanup if needed (optional)
      setTimeout(() => {
        const roomInfo = getRoomInfo(currentSession);
        if (roomInfo.size === 0) {
          // Optionally cleanup empty sessions after some time
          // sessionContent.delete(currentSession);
          // activeSessions.delete(currentSession);
        }
      }, 5000);
    }
  });

  // Error handling
  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// API endpoint to get session stats
app.get("/api/stats", (req, res) => {
  try {
    const stats = {
      activeSessions: activeSessions.size,
      totalConnections: io.sockets.sockets.size,
      sessions: Array.from(activeSessions.entries()).map(([code, info]) => ({
        code,
        ...info,
        roomSize: getRoomInfo(code).size,
      })),
    };
    res.json(stats);
  } catch (error) {
    console.error("Error getting stats:", error);
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO server ready`);
  console.log(`🔧 Code length: ${CODE_LENGTH}`);
  console.log(`🌍 Environment: ${NODE_ENV}`);
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
