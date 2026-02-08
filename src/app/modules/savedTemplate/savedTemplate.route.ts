import express from "express";
import multer from "multer";
import path from "path";
import { requireAdminOrSeller } from "../../middleware/auth";
import { SavedTemplateController } from "./savedTemplate.controller";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(process.cwd(), "uploads"));
  },
  filename: (_req, file, cb) => {
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
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get("/", requireAdminOrSeller, SavedTemplateController.list);
router.post("/text", requireAdminOrSeller, SavedTemplateController.createText);
router.post(
  "/media",
  requireAdminOrSeller,
  upload.fields([{ name: "files", maxCount: 10 }, { name: "file", maxCount: 1 }]),
  SavedTemplateController.createMedia
);

// Update supports JSON OR multipart (to replace media files)
router.put(
  "/:id",
  requireAdminOrSeller,
  upload.fields([{ name: "files", maxCount: 10 }, { name: "file", maxCount: 1 }]),
  SavedTemplateController.update
);
router.delete("/:id", requireAdminOrSeller, SavedTemplateController.remove);

export const SavedTemplateRoutes = router;
