import { Router } from "express";
import { AdminController } from "./admin.controller";
import { requireAdminKey, requireSuperAdmin } from "../../middleware/auth";
import { rateLimitAdminLogin } from "../../middleware/rateLimit";

const router = Router();

// POST /api/admin/login  (super admin or sub admin)
router.post("/login", rateLimitAdminLogin, AdminController.login);

// ✅ Current admin profile (used by UI to render permissions without refresh)
router.get("/me", requireAdminKey, AdminController.me);

// ✅ Change own password (super/sub). Revokes existing sessions via token_version.
router.post("/change-password", requireAdminKey, AdminController.changePassword);

// ✅ Super admin management (sub-admin CRUD)
router.get("/sub-admins", requireSuperAdmin, AdminController.listSubAdmins);
router.post("/sub-admins/invite", requireSuperAdmin, AdminController.inviteSubAdmin);
router.post("/sub-admins", requireSuperAdmin, AdminController.createSubAdmin);
router.patch("/sub-admins/:id", requireSuperAdmin, AdminController.updateSubAdmin);
router.delete("/sub-admins/:id", requireSuperAdmin, AdminController.deleteSubAdmin);

// Public-ish: sub admin accepts invite & sets password
router.post("/accept-invite", AdminController.acceptInvite);

// Super admin audit logs
router.get("/audit-logs", requireSuperAdmin, AdminController.listAuditLogs);

export const AdminRoutes = router;
