import axios from "axios";

export type MetaPlatform = "facebook" | "instagram";

export type MetaPage = {
  id: string;
  name: string;
  access_token: string;
};

const GRAPH_VERSION = String(process.env.META_GRAPH_VERSION || "v19.0").trim();

function graphBase() {
  return `https://graph.facebook.com/${GRAPH_VERSION}`;
}

export function buildOAuthScopes(platform: MetaPlatform): string {
  // Keep scopes minimal but sufficient for listing pages + Messenger / IG DM.
  // Note: production apps may need App Review / advanced access.
  if (platform === "instagram") {
    return [
      "pages_show_list",
      "instagram_basic",
      "instagram_manage_messages",
      "pages_manage_metadata",
    ].join(",");
  }

  return [
    "pages_show_list",
    "pages_manage_metadata",
    "pages_messaging",
    "pages_read_engagement",
  ].join(",");
}

export async function exchangeCodeForUserToken(args: {
  code: string;
  redirectUri: string;
  appId: string;
  appSecret: string;
}): Promise<{ access_token: string; expires_in?: number }> {
  const { code, redirectUri, appId, appSecret } = args;
  const url = `${graphBase()}/oauth/access_token`;
  const res = await axios.get(url, {
    params: {
      client_id: appId,
      redirect_uri: redirectUri,
      client_secret: appSecret,
      code,
    },
    timeout: 15000,
  });
  return res.data;
}

export async function fetchUserPages(userAccessToken: string): Promise<MetaPage[]> {
  const url = `${graphBase()}/me/accounts`;
  const res = await axios.get(url, {
    params: {
      fields: "id,name,access_token",
      access_token: userAccessToken,
    },
    timeout: 15000,
  });
  const data = res.data;
  const pages: MetaPage[] = Array.isArray(data?.data) ? data.data : [];
  return pages
    .map((p: any) => ({
      id: String(p?.id || "").trim(),
      name: String(p?.name || "").trim(),
      access_token: String(p?.access_token || "").trim(),
    }))
    .filter((p) => p.id && p.access_token);
}

export async function subscribePageToWebhooks(pageId: string, pageAccessToken: string): Promise<void> {
  // Attempts to subscribe the app to the page's webhooks.
  const url = `${graphBase()}/${encodeURIComponent(pageId)}/subscribed_apps`;
  await axios.post(
    url,
    null,
    {
      params: {
        access_token: pageAccessToken,
      },
      timeout: 15000,
    }
  );
}
