export type LiveMsg = {
  id?: number;
  replyToMessageId?: string | number | null;
  conversationId: string;
  customerName: string;
  sender: "customer" | "bot";
  message: string;
  platform: "facebook" | "instagram";
  pageId: string;
  timestamp: string;
};
