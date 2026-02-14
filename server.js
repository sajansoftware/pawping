require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const twilio = require("twilio");

// --- Config ---
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  ANTHROPIC_API_KEY,
  CLINIC_NAME = "Our Veterinary Clinic",
  PORT = "3000",
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error("Missing required TWILIO_* environment variables. See .env.example");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable. See .env.example");
  process.exit(1);
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- In-memory conversation store ---
// Map<phoneNumber, { messages: Array<{role, content}>, lastActivity: Date }>
const conversations = new Map();

const CONVERSATION_TTL_MS = 60 * 60 * 1000; // 1 hour

function getConversation(phone) {
  const conv = conversations.get(phone);
  if (conv && Date.now() - conv.lastActivity < CONVERSATION_TTL_MS) {
    conv.lastActivity = Date.now();
    return conv;
  }
  const fresh = { messages: [], lastActivity: Date.now() };
  conversations.set(phone, fresh);
  return fresh;
}

// Periodic cleanup of stale conversations
setInterval(() => {
  const now = Date.now();
  for (const [phone, conv] of conversations) {
    if (now - conv.lastActivity >= CONVERSATION_TTL_MS) {
      conversations.delete(phone);
    }
  }
}, 10 * 60 * 1000);

// --- System prompt for Claude ---
const SYSTEM_PROMPT = `You are PawPing, a friendly and helpful AI assistant for ${CLINIC_NAME}, a veterinary clinic. You are texting with a pet owner who just tried to call the clinic.

Your job:
- Help them book appointments, request medication refills, or answer general questions.
- Be warm, concise, and professional. Keep replies under 300 characters when possible (SMS limit).
- Use a friendly tone with occasional pet-related emoji (🐾 🐶 🐱).
- If they want to book an appointment, ask for: pet name, species/breed, reason for visit, and preferred date/time.
- If they want a refill, ask for: pet name and medication name.
- For emergencies, tell them to call the clinic directly or go to the nearest emergency vet.
- Never make up clinic hours, pricing, or medical advice. If unsure, say you'll have the clinic follow up.
- Keep the conversation focused and helpful. You're texting, so be brief.`;

// --- Routes ---

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "PawPing" });
});

// Twilio call status webhook — fires when a call ends
// Configure this as the "Status Callback URL" on your Twilio number
app.post("/webhook/call-status", async (req, res) => {
  const { CallStatus, From, To } = req.body;

  console.log(`Call status: ${CallStatus} from ${From}`);

  if (CallStatus === "no-answer" || CallStatus === "busy") {
    try {
      const greeting =
        `Hi! Thanks for calling ${CLINIC_NAME}. 🐾 Sorry we missed you — ` +
        `how can we help? Reply APPT to book, REFILL for meds, or just tell us what you need!`;

      await twilioClient.messages.create({
        body: greeting,
        from: TWILIO_PHONE_NUMBER,
        to: From,
      });

      // Seed the conversation so Claude has context
      const conv = getConversation(From);
      conv.messages.push({ role: "assistant", content: greeting });

      console.log(`Sent missed-call SMS to ${From}`);
    } catch (err) {
      console.error(`Failed to send SMS to ${From}:`, err.message);
    }
  }

  res.sendStatus(200);
});

// Twilio incoming SMS webhook — receives replies from callers
// Configure this as the "Messaging Webhook" on your Twilio number
app.post("/webhook/sms", async (req, res) => {
  const { From, Body } = req.body;
  const incomingText = (Body || "").trim();

  console.log(`SMS from ${From}: ${incomingText}`);

  const conv = getConversation(From);
  conv.messages.push({ role: "user", content: incomingText });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: conv.messages,
    });

    const replyText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    conv.messages.push({ role: "assistant", content: replyText });

    // Respond with TwiML so Twilio sends the reply
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(replyText);

    res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error(`Claude API error for ${From}:`, err.message);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(
      `Sorry, we're having a little trouble right now. Please try again or call ${CLINIC_NAME} directly. 🐾`
    );
    res.type("text/xml").send(twiml.toString());
  }
});

// --- Start ---
app.listen(parseInt(PORT, 10), () => {
  console.log(`PawPing running on port ${PORT}`);
  console.log(`Clinic: ${CLINIC_NAME}`);
  console.log(`Twilio number: ${TWILIO_PHONE_NUMBER}`);
  console.log(`Endpoints:`);
  console.log(`  POST /webhook/call-status  — Twilio call status callback`);
  console.log(`  POST /webhook/sms          — Twilio incoming SMS webhook`);
});
