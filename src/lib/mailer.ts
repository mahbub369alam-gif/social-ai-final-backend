import nodemailer from "nodemailer";

type Transporter = ReturnType<typeof nodemailer.createTransport>;

let cachedTransporter: Transporter | null = null;

const boolFromEnv = (v: any, def = false) => {
  if (v === undefined || v === null) return def;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
};

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;

  const host = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = boolFromEnv(process.env.SMTP_SECURE, false);
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();

  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS)");
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return cachedTransporter;
};

export const sendInviteEmail = async (toEmail: string, inviteLink: string) => {
  const from = String(process.env.MAIL_FROM || process.env.SMTP_USER || "").trim();
  if (!from) throw new Error("MAIL_FROM or SMTP_USER required");

  const transporter = getTransporter();

  const safeTo = String(toEmail || "").trim();
  if (!safeTo) throw new Error("Recipient email missing");

  const subject = "You're invited as Sub Admin";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6;">
      <p>Hello,</p>
      <p>You have been invited to access the Takesell Admin panel as a <b>Sub Admin</b>.</p>
      <p>
        Click the button below to set your password. This link expires in <b>30 minutes</b> and can be used only once.
      </p>
      <p>
        <a href="${inviteLink}" style="display:inline-block;padding:10px 14px;border-radius:6px;background:#111;color:#fff;text-decoration:none;">
          Set Password
        </a>
      </p>
      <p>If the button doesn't work, copy and paste this link into your browser:</p>
      <p><a href="${inviteLink}">${inviteLink}</a></p>
      <p>If you did not expect this email, you can ignore it.</p>
    </div>
  `;

  await transporter.sendMail({
    from,
    to: safeTo,
    subject,
    html,
  });

  return true;
};
