const nodemailer = require('nodemailer');

/**
 * Lazily-built nodemailer transporter so the app boots even before
 * SMTP credentials are configured.  Real failures surface only when
 * we actually try to send.
 */
let cachedTransporter = null;

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.SMTP_EMAIL || !process.env.SMTP_PASSWORD) {
    throw new Error(
      'SMTP credentials missing. Set SMTP_EMAIL and SMTP_PASSWORD in backend/.env (Gmail App Password).'
    );
  }
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465, // 465 = SSL, 587 = STARTTLS
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return cachedTransporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  const from = `"${process.env.SMTP_FROM_NAME || 'HRMS Support'}" <${process.env.SMTP_EMAIL}>`;
  const transporter = getTransporter();
  const info = await transporter.sendMail({ from, to, subject, html, text });
  console.log(`[email] sent to ${to} - messageId ${info.messageId}`);
  return info;
};

/**
 * Pretty HTML password-reset email.
 */
const sendPasswordResetEmail = async ({ to, employeeName, resetUrl, ttlMinutes }) => {
  const subject = 'Password Reset Request Approved';
  const text = `Hello ${employeeName},

Your password reset request has been approved by HR.

Click the secure link below to reset your password:
${resetUrl}

Important:
- This link can only be used once.
- Link expires after ${ttlMinutes} minutes.

If you did not request this, contact HR immediately.

Regards,
HRMS Support Team`;

  const html = `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto;background:#f8fafc;padding:24px">
    <div style="background:white;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
      <div style="background:#4f46e5;color:white;padding:18px 24px;">
        <div style="font-size:13px;letter-spacing:.5px;opacity:.85">HRMS PLATFORM</div>
        <div style="font-size:18px;font-weight:600;margin-top:2px">Password Reset Request Approved</div>
      </div>
      <div style="padding:22px 24px;color:#0f172a;font-size:14px;line-height:1.55">
        <p>Hello <b>${employeeName || 'there'}</b>,</p>
        <p>Your password reset request has been <b>approved</b> by HR.</p>
        <p>Click the secure button below to set a new password:</p>
        <p style="text-align:center;margin:24px 0">
          <a href="${resetUrl}"
             style="display:inline-block;background:#4f46e5;color:white;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">
            Reset my password
          </a>
        </p>
        <p style="font-size:12px;color:#64748b">
          Or copy this link into your browser:<br/>
          <span style="word-break:break-all;color:#334155">${resetUrl}</span>
        </p>
        <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;font-size:12px;color:#92400e;margin-top:18px">
          <b>Important:</b> This link can only be used <b>once</b> and will expire in <b>${ttlMinutes} minutes</b>.
          If you did not request this, contact HR immediately.
        </div>
        <p style="margin-top:24px;color:#475569;font-size:13px">Regards,<br/>HRMS Support Team</p>
      </div>
    </div>
  </div>`;

  return sendMail({ to, subject, html, text });
};

/**
 * Welcome email sent the moment HR / Super Admin successfully creates a
 * new employee account.  Re-uses the same SMTP transport as password
 * reset; failures here MUST be swallowed by the caller so employee
 * creation never rolls back.
 */
const sendWelcomeEmail = async ({ to, employeeName, designationTitle, loginUrl }) => {
  const subject = 'Welcome to Agromaxx Industry HRMS';
  const designationLine = designationTitle && designationTitle.trim() ? designationTitle : 'Not assigned yet';

  const text = `Hello ${employeeName || 'there'},

Welcome to Agromaxx Industry.
Your employee account has been created successfully.

Designation:
${designationLine}

You can access the HRMS portal using the link below:
${loginUrl}

Please log in using the credentials provided by HR.

We wish you success in your journey with Agromaxx Industry.

Regards,
HR Team
Agromaxx Industry`;

  const html = `
  <div style="font-family:Helvetica,Arial,sans-serif;max-width:560px;margin:auto;background:#f8fafc;padding:24px">
    <div style="background:white;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
      <div style="background:#1e3a8a;color:white;padding:20px 24px;">
        <div style="font-size:12px;letter-spacing:1px;opacity:.85;text-transform:uppercase">Agromaxx Industry</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px">Welcome to the HRMS Portal</div>
      </div>
      <div style="padding:24px;color:#0f172a;font-size:14px;line-height:1.6">
        <p style="margin:0 0 12px 0">Hello <b>${employeeName || 'there'}</b>,</p>
        <p style="margin:0 0 12px 0">Welcome to <b>Agromaxx Industry</b>. Your employee account has been created successfully.</p>
        <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin:16px 0">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;font-weight:600">Designation</div>
          <div style="font-size:15px;font-weight:600;color:#0f172a;margin-top:2px">${designationLine}</div>
        </div>
        <p style="margin:0 0 8px 0">You can access the HRMS portal using the link below:</p>
        <p style="text-align:center;margin:22px 0 10px 0">
          <a href="${loginUrl}"
             style="display:inline-block;background:#1e3a8a;color:white;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">
            Open HRMS Portal
          </a>
        </p>
        <p style="font-size:12px;color:#64748b;text-align:center;margin:0 0 18px 0">
          <a href="${loginUrl}" style="color:#1e3a8a;word-break:break-all">${loginUrl}</a>
        </p>
        <p style="margin:0 0 12px 0">Please log in using the credentials provided by HR.</p>
        <p style="margin:0 0 4px 0">We wish you success in your journey with Agromaxx Industry.</p>
        <p style="margin:20px 0 0 0;color:#475569;font-size:13px">Regards,<br/><b>HR Team</b><br/>Agromaxx Industry</p>
      </div>
    </div>
  </div>`;

  return sendMail({ to, subject, html, text });
};

module.exports = { sendMail, sendPasswordResetEmail, sendWelcomeEmail };
