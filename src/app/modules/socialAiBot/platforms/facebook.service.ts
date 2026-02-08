import axios from "axios";

export type UserProfile = {
  name?: string;
  profilePic?: string;
  username?: string;
};

export const fetchFacebookUserProfile = async (
  psid: string,
  pageAccessToken: string
): Promise<UserProfile | null> => {
  try {
    if (!psid || !pageAccessToken) return null;

    const { data } = await axios.get(
      `https://graph.facebook.com/v18.0/${encodeURIComponent(psid)}`,
      {
        params: {
          fields: "first_name,last_name,profile_pic",
          access_token: pageAccessToken,
        },
        timeout: 12000,
      }
    );

    const fullName =
      `${data?.first_name || ""} ${data?.last_name || ""}`.trim() || undefined;

    return { name: fullName, profilePic: data?.profile_pic || undefined };
  } catch {
    return null;
  }
};

export const fetchInstagramUserProfile = async (
  igScopedId: string,
  pageAccessToken: string
): Promise<UserProfile | null> => {
  try {
    if (!igScopedId || !pageAccessToken) return null;

    const { data } = await axios.get(
      `https://graph.facebook.com/v18.0/${encodeURIComponent(igScopedId)}`,
      {
        params: {
          fields: "name,username,profile_pic",
          access_token: pageAccessToken,
        },
        timeout: 12000,
      }
    );

    return {
      name: data?.name || undefined,
      username: data?.username || undefined,
      profilePic: data?.profile_pic || undefined,
    };
  } catch {
    return null;
  }
};