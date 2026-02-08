import express from "express";
import multer from "multer";
import path from "path";
import { SocialAiBotController } from "./socialAiBot.controller";
import { requireAdminOrSeller } from "../../middleware/auth";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(process.cwd(), "uploads"));
  },
  filename: (_req, file, cb) => {
    // preserve extension so Content-Type is correct when served statically
    const ext = path.extname(file.originalname || "");
    const safeBase = path
      .basename(file.originalname || "upload", ext)
      .replace(/[^a-zA-Z0-9-_]/g, "_")
      .slice(0, 50);
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});

const upload = multer({
  storage,
  // ✅ 50MB max (videos are usually larger)
  limits: { fileSize: 50 * 1024 * 1024 },
});


router
  .route("/facebook/webhook")
  .get(SocialAiBotController.handleFacebookWebhook)
  .post(SocialAiBotController.handleFacebookWebhook);

router.get("/conversations", requireAdminOrSeller, SocialAiBotController.getConversations);
router.post(
  "/conversations/:conversationId/mark-read",
  requireAdminOrSeller,
  SocialAiBotController.markConversationReadApi
);
router.post(
  "/conversations/:conversationId/mark-unread",
  requireAdminOrSeller,
  SocialAiBotController.markConversationUnreadApi
);
// Admin only: assign/unassign + delivery status
router.patch(
  "/conversations/:conversationId/meta",
  requireAdminOrSeller,
  SocialAiBotController.updateConversationMeta
);
router.get(
  "/messages/:conversationId",
  requireAdminOrSeller,
  SocialAiBotController.getMessagesByConversation
);

router.post("/manual-reply", requireAdminOrSeller, SocialAiBotController.manualReply);

router.post(
  "/manual-media-reply",
  requireAdminOrSeller,
  upload.fields([{ name: "files", maxCount: 10 }, { name: "file", maxCount: 1 }]),
  SocialAiBotController.manualMediaReply

);

// Forward an existing message from one customer inbox to another
router.post("/forward-message", requireAdminOrSeller, SocialAiBotController.forwardMessage);

export const SocialAiBotRoutes = router;
