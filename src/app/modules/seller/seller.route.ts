import express from "express";
import { SellerController } from "./seller.controller";
import { requireAdminKey } from "../../middleware/auth";

const router = express.Router();

// admin actions
router.post("/", requireAdminKey, SellerController.createSeller);
router.get("/", requireAdminKey, SellerController.listSellers);
router.delete("/:id", requireAdminKey, SellerController.deleteSeller);

// seller auth
router.post("/login", SellerController.loginSeller);

export const SellerRoutes = router;
