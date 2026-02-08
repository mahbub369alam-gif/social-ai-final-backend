import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import { SocialAiBotRoutes } from "./modules/socialAiBot/socialAiBot.route";
import { SellerRoutes } from "./modules/seller/seller.route";
import { AdminRoutes } from "./modules/admin/admin.route";
import { ApiIntegrationRoutes } from "./modules/apiIntegration/apiIntegration.route";
import { SavedTemplateRoutes } from "./modules/savedTemplate/savedTemplate.route";

const app = express();

// ✅ ensure uploads folder exists (multer + static files)
try {
  fs.mkdirSync(path.join(process.cwd(), "uploads"), { recursive: true });
} catch { }

// ✅ static uploads (image/video public url)
// app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use(
  "/uploads",
  express.static(path.join(process.cwd(), "uploads"), {
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    },
  })
);



/**
 * ✅ CORS
 * - UI (Next.js) runs on http://localhost:3000
 * - Backend runs on http://localhost:5000
 */
app.use(
  cors({
    origin: ["http://ui-rosy-rho.vercel.app"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // x-admin-key is required for seller admin endpoints
    allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"],
  })
);

// ✅ Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * ✅ Health check
 */
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * Social AI Bot Routes
 */
app.use("/api/social-ai-bot", SocialAiBotRoutes);

/**
 * Seller Routes
 * - Admin:   GET/POST /api/sellers   (requires x-admin-key)
 * - Seller:  POST     /api/sellers/login
 */
app.use("/api/sellers", SellerRoutes);

/**
 * Admin Auth Routes
 * - POST /api/admin/login (username/password -> JWT admin token)
 */
app.use("/api/admin", AdminRoutes);

/**
 * API Integrations
 * - Admin: GET/POST /api/integrations/facebook (requires x-admin-key or admin JWT)
 */
app.use("/api/integrations", ApiIntegrationRoutes);

/**
 * Saved templates (quick replies)
 * - GET/POST/PUT/DELETE /api/templates
 */
app.use("/api/templates", SavedTemplateRoutes);

export default app;
