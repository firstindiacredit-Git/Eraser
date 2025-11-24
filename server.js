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

    // Get room size to check if others are connected
    const room = io.sockets.adapter.rooms.get(sessionCode);
    const roomSize = room ? room.size : 0;

    // Send current room content to the new user
    socket.emit("content:sync", sessionContent.get(sessionCode));
    socket.emit("join:success", sessionCode);

    // Notify other users in the room that someone joined
    if (roomSize > 1) {
      socket.to(sessionCode).emit("user:joined", { roomSize });
      socket.emit("user:joined", { roomSize });
    }
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
    socket.emit("user:joined", { roomSize: 1 }); // Only creator for now
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
