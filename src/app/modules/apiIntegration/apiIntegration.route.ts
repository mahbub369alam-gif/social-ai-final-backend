import express from "express";
import { requireAdminKey } from "../../middleware/auth";
import { ApiIntegrationController } from "./apiIntegration.controller";
import { OAuthIntegrationController } from "./oauth.controller";

const router = express.Router();

// ✅ For now: only Facebook works (IG/WhatsApp will be UI placeholder)
router.get("/facebook", requireAdminKey, ApiIntegrationController.getFacebook);
router.get("/facebook/pages", requireAdminKey, ApiIntegrationController.listActiveFacebook);
router.post("/facebook", requireAdminKey, ApiIntegrationController.saveFacebook);
router.get("/instagram/pages", requireAdminKey, ApiIntegrationController.listActiveInstagram);

// ✅ OAuth onboarding (Facebook)
router.get("/facebook/oauth/start", OAuthIntegrationController.facebook.start);
router.get("/facebook/oauth/callback", OAuthIntegrationController.facebook.callback);
router.get("/facebook/oauth/pages", requireAdminKey, OAuthIntegrationController.facebook.pages);
router.post("/facebook/oauth/select", requireAdminKey, OAuthIntegrationController.facebook.select);

// ✅ OAuth onboarding (Instagram)
router.get("/instagram/oauth/start", OAuthIntegrationController.instagram.start);
router.get("/instagram/oauth/callback", OAuthIntegrationController.instagram.callback);
router.get("/instagram/oauth/pages", requireAdminKey, OAuthIntegrationController.instagram.pages);
router.post("/instagram/oauth/select", requireAdminKey, OAuthIntegrationController.instagram.select);

export const ApiIntegrationRoutes = router;
