const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// Must be a sender/domain you've verified in your Resend dashboard.
const FROM_EMAIL = process.env.FROM_EMAIL || 'Transport Board <onboarding@resend.dev>';
// Where reset links / admin panel links should point.
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://transport-voting-1.onrender.com';
// Address admin change-request notifications go to.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

const DIRECTION_LABEL = {
  to_campus: 'To Campus',
  to_residence: 'To Residence',
};

// All three senders below deliberately swallow their own errors (log +
// return) rather than throwing. Email is a side effect, not the point of
// the request — a booking, a change request, or a signup should never
// fail just because Resend had a hiccup.

async function sendPasswordResetEmail({ to, studentId, token }) {
  if (!to) return;
  const resetUrl = `${FRONTEND_URL}/?resetToken=${encodeURIComponent(token)}&studentId=${encodeURIComponent(studentId)}`;
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Reset your Transport Board password',
      html: `
        <p>Someone requested a password reset for student number <b>${studentId}</b>.</p>
        <p><a href="${resetUrl}">Click here to set a new password</a>. This link expires in 15 minutes.</p>
        <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
      `,
    });
    console.log(`[mailer] Password reset email sent to ${to}`);
  } catch (err) {
    console.error('[mailer] Failed to send password reset email:', err);
  }
}

async function sendAdminChangeRequestEmail({ studentId, username, direction, slotTime, note }) {
  if (!ADMIN_EMAIL) {
    console.warn('[mailer] ADMIN_EMAIL not set — skipping admin change-request notification.');
    return;
  }
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: ADMIN_EMAIL,
      subject: `New change request from ${username} (#${studentId})`,
      html: `
        <p><b>${username}</b> (#${studentId}) requested a change on their
        <b>${DIRECTION_LABEL[direction] || direction}</b> booking (currently ${slotTime}).</p>
        ${note ? `<p>Note from student: "${note}"</p>` : ''}
        <p><a href="${FRONTEND_URL}">Open the admin panel to review</a>.</p>
      `,
    });
    console.log(`[mailer] Admin change-request notification sent for ${studentId}`);
  } catch (err) {
    console.error('[mailer] Failed to send admin change-request email:', err);
  }
}

async function sendDepartureReminderEmail({ to, username, time, direction }) {
  if (!to) return;
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Your ${time} shuttle leaves in 5 minutes`,
      html: `
        <p>Hi ${username},</p>
        <p>Your <b>${DIRECTION_LABEL[direction] || direction}</b> shuttle at <b>${time}</b>
        leaves in about 5 minutes — head down now.</p>
      `,
    });
    console.log(`[mailer] Departure reminder sent to ${to} for slot ${time}`);
  } catch (err) {
    console.error('[mailer] Failed to send departure reminder email:', err);
  }
}

module.exports = {
  sendPasswordResetEmail,
  sendAdminChangeRequestEmail,
  sendDepartureReminderEmail,
};