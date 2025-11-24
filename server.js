import { createServer } from "http";
import { Server } from "socket.io";
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

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Store content per room (connection code)
const sessionContent = new Map();

// Generate a random connection code using environment variables
function generateConnectionCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

io.on("connection", (socket) => {
  let currentSession = null;

  // Send code configuration to client on connection
  socket.emit("code:config", { length: CODE_LENGTH });

  // Handle joining a room with connection code
  socket.on("join:session", (code) => {
    if (typeof code !== "string" || code.length !== CODE_LENGTH) {
      socket.emit(
        "join:error",
        `Invalid connection code. Must be ${CODE_LENGTH} characters.`
      );
      return;
    }

    const sessionCode = code.toUpperCase();

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
    }

    // Send current room content to the new user
    socket.emit("content:sync", sessionContent.get(sessionCode));
    socket.emit("join:success", sessionCode);

    // Get room size AFTER joining to ensure accurate count
    // Use a small delay to ensure socket is fully joined in the room
    setTimeout(() => {
      const room = io.sockets.adapter.rooms.get(sessionCode);
      const roomSize = room ? room.size : 0;

      // Notify ALL users in the room (including creator) that someone joined
      // This ensures the creator also sees the typing pad when someone joins
      if (roomSize > 1) {
        // Emit to ALL sockets in the room - both creator and joiner
        io.to(sessionCode).emit("user:joined", {
          roomSize,
          code: sessionCode,
        });

        // Also explicitly notify each socket in the room individually
        // This ensures creator definitely gets the event
        const socketsInRoom = Array.from(room);
        console.log(
          `Room ${sessionCode} has ${roomSize} users, notifying all...`
        );
        socketsInRoom.forEach((socketId) => {
          const socketInRoom = io.sockets.sockets.get(socketId);
          if (socketInRoom) {
            // Notify ALL sockets including creator and joiner
            socketInRoom.emit("user:joined", {
              roomSize,
              code: sessionCode,
            });
            console.log(`Sent user:joined to socket ${socketId}`);
          }
        });
      }
    }, 150);
  });

  // Handle creating a new room
  socket.on("create:session", () => {
    const newCode = generateConnectionCode();

    // Leave previous room if any
    if (currentSession) {
      socket.leave(currentSession);
    }

    // Initialize new room
    sessionContent.set(newCode, "");
    socket.join(newCode);
    currentSession = newCode;

    socket.emit("join:success", newCode);
    socket.emit("content:sync", "");
    // Don't emit user:joined here - wait until someone actually joins
  });

  socket.on("content:update", (nextValue) => {
    if (typeof nextValue !== "string" || !currentSession) return;

    sessionContent.set(currentSession, nextValue);
    socket.to(currentSession).emit("content:sync", nextValue);
  });

  socket.on("typing", (isTyping) => {
    if (currentSession) {
      socket.to(currentSession).emit("typing", Boolean(isTyping));
    }
  });

  socket.on("leave:session", () => {
    if (currentSession) {
      socket.leave(currentSession);
      currentSession = null;
    }
  });

  socket.on("disconnect", () => {
    // Room content persists even when users disconnect
    // You could add cleanup logic here if needed
  });
});

httpServer.listen(PORT, () => {
  console.log(`Realtime relay ready on http://localhost:${PORT}`);
});
