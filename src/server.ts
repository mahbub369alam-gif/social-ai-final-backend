// IMPORTANT: Load environment variables BEFORE importing the app.
// Some controllers/services read process.env during module initialization.
import "dotenv/config";
console.log(`[BOOT] cwd=${process.cwd()} GROQ_API_KEY_present=${Boolean(process.env.GROQ_API_KEY)}`);
import app from "./app/app";
import { ensureMySqlSchema, getMySqlPool } from "./lib/mysql";
import { queryRows } from "./lib/mysql";
import { refreshIntegrationCache } from "./lib/integrationCache";

import http from "http";
import { Server as SocketIOServer } from "socket.io";
import jwt from "jsonwebtoken";

const PORT = process.env.PORT || 5000;

// ✅ Create HTTP server
const httpServer = http.createServer(app);

// ✅ Attach Socket.IO
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*", // পরে production এ তোমার UI domain দিয়ে lock করবে
    methods: ["GET", "POST"],
  },
});

// ✅ Make io accessible in controllers via req.app.get("io")
app.set("io", io);

const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";

// ✅ Socket auth:
// - Seller connects with `{ auth: { token } }`
// - Admin connects with `{ auth: { adminKey } }` (same as ADMIN_API_KEY)
// - Admin can also connect with JWT `{ auth: { token } }` where payload role='admin'
io.use(async (socket, next) => {
  try {
    const adminKey = String((socket.handshake as any)?.auth?.adminKey || "");
    const expectedAdmin = String(process.env.ADMIN_API_KEY || "");
    if (expectedAdmin && adminKey && adminKey === expectedAdmin) {
      (socket.data as any).user = { role: "admin", id: "admin" };
      return next();
    }

    const token = String((socket.handshake as any)?.auth?.token || "");
    if (!token) return next(); // allow connection but no rooms

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded?.role === "admin") {
      (socket.data as any).user = { role: "admin", id: String(decoded?.id || "admin") };
      return next();
    }

    const sellerId = String(decoded?.sellerId || decoded?.id || "");
    const tokenVersion = Number(decoded?.tokenVersion || 0);
    if (sellerId && tokenVersion) {
      // Validate seller is still active and token is not revoked.
      const rows = await queryRows<any[]>("SELECT is_active, token_version FROM sellers WHERE id=? LIMIT 1", [sellerId]);
      if (rows?.length && rows[0].is_active && Number(rows[0].token_version || 0) === tokenVersion) {
        (socket.data as any).user = { role: "seller", id: sellerId };
      }
    }
    return next();
  } catch {
    // invalid token -> still allow, but no rooms
    return next();
  }
});

io.on("connection", (socket) => {
  console.log("🟢 UI connected:", socket.id);

  // join rooms based on identity
  const u = (socket.data as any).user;
  if (u?.role === "admin") {
    socket.join("admin");
  } else if (u?.role === "seller" && u?.id) {
    socket.join("sellers");
    socket.join(`seller:${u.id}`);
  }

  socket.on("disconnect", () => {
    console.log("🔴 UI disconnected:", socket.id);
  });
});


(async () => {
  try {
    // ✅ connect + optional schema bootstrap
    const pool = getMySqlPool();
    await pool.query("SELECT 1");
    await ensureMySqlSchema();
    await refreshIntegrationCache();
    console.log("MySQL connected");

    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("MySQL connection failed:", err);
    process.exit(1);
  }
})();