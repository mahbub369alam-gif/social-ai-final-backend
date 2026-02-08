import axios from "axios";

export const getFacebookUserName = async (
  psid: string,
  pageAccessToken: string
): Promise<string> => {
  try {
    const res = await axios.get(`https://graph.facebook.com/v19.0/${psid}`, {
      params: {
        fields: "name",
        access_token: pageAccessToken,
      },
    });

    return res.data?.name || psid;
  } catch (error) {
    console.error("Failed to fetch Facebook user name:", error);
    return psid;
  }
};

