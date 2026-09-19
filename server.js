import crypto from "node:crypto";
import "dotenv/config";
import express from "express";
import cors from "cors";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "64kb" }));

const VoiceResponse = twilio.twiml.VoiceResponse;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

const calls = new Map();

app.get("/health", (_req, res) => res.json({ ok: true, service: "MACHI TALK V4", mode: "two-leg-realtime-translator" }));

app.post("/call/start", async (req, res) => {
  try {
    const { myNumber, customerNumber, myLanguage = "Tamil", customerLanguage = "Hindi" } = req.body || {};
    if (!myNumber || !customerNumber) return res.status(400).json({ error: "myNumber and customerNumber are required" });
    if (!process.env.TWILIO_PHONE_NUMBER) return res.status(500).json({ error: "TWILIO_PHONE_NUMBER is not configured" });
    if (!PUBLIC_BASE_URL) return res.status(500).json({ error: "PUBLIC_BASE_URL is not configured" });

    const sessionId = crypto.randomUUID();
    calls.set(sessionId, { myNumber, customerNumber, myLanguage, customerLanguage, createdAt: Date.now(), legs: {} });

    const twimlUrl = `${PUBLIC_BASE_URL.replace(/\/$/, "")}/twiml/leg/${sessionId}`;
    const [mine, theirs] = await Promise.all([
      client.calls.create({ to: myNumber, from: process.env.TWILIO_PHONE_NUMBER, url: `${twimlUrl}?side=me`, method: "POST" }),
      client.calls.create({ to: customerNumber, from: process.env.TWILIO_PHONE_NUMBER, url: `${twimlUrl}?side=customer`, method: "POST" })
    ]);
    calls.get(sessionId).legs.me = mine.sid;
    calls.get(sessionId).legs.customer = theirs.sid;
    res.json({ ok: true, sessionId, myCallSid: mine.sid, customerCallSid: theirs.sid, message: "Calling both sides. Answer both calls to start translation." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Unable to start call" });
  }
});

app.post("/twiml/leg/:sessionId", (req, res) => {
  const session = calls.get(req.params.sessionId);
  if (!session) return res.status(404).send("Unknown session");
  const side = req.query.side === "customer" ? "customer" : "me";
  const vr = new VoiceResponse();
  const connect = vr.connect();
  const host = new URL(PUBLIC_BASE_URL).host;
  const stream = connect.stream({ url: `wss://${host}/media/${req.params.sessionId}?side=${side}` });
  stream.parameter({ name: "side", value: side });
  vr.say({ language: side === "me" ? "en-US" : "en-US" }, side === "me" ? "MACHI TALK is connecting your translated call." : "MACHI TALK is connecting your translated call.");
  res.type("text/xml").send(vr.toString());
});

app.post("/call/end", async (req, res) => {
  const { sessionId } = req.body || {};
  const session = calls.get(sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  await Promise.all(Object.values(session.legs || {}).map(async sid => {
    try { await client.calls(sid).update({ status: "completed" }); } catch {}
  }));
  calls.delete(sessionId);
  res.json({ ok: true });
});

const server = app.listen(PORT, () => console.log(`MACHI TALK V4 server listening on ${PORT}`));
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const match = request.url?.match(/^\/media\/([^?]+)\?side=(me|customer)$/);
  if (!match) return socket.destroy();
  wss.handleUpgrade(request, socket, head, ws => {
    ws.sessionId = match[1];
    ws.side = match[2];
    wss.emit("connection", ws, request);
  });
});

function targetLanguage(session, side) {
  return side === "me" ? session.customerLanguage : session.myLanguage;
}
function sourceLanguage(session, side) {
  return side === "me" ? session.myLanguage : session.customerLanguage;
}

async function openRealtime(languageFrom, languageTo) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`;
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("OpenAI realtime connection timeout")), 15000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      instructions: `You are a live phone interpreter. The speaker is using ${languageFrom}. Translate what they say naturally into conversational ${languageTo}. Preserve meaning, names, numbers, prices, order details and tone. Do not answer the speaker, explain anything, summarize, or add words. Output only the translated speech in ${languageTo}. Speak like a normal person in a customer conversation, not formal literary language.`,
      input_audio_format: { type: "audio/pcmu" },
      output_audio_format: { type: "audio/pcmu" },
      turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
      voice: "marin"
    }
  }));
  return ws;
}

wss.on("connection", async (twilioWs, req) => {
  const session = calls.get(twilioWs.sessionId);
  if (!session || !OPENAI_API_KEY) return twilioWs.close();
  let openaiWs;
  try {
    openaiWs = await openRealtime(sourceLanguage(session, twilioWs.side), targetLanguage(session, twilioWs.side));
  } catch (err) {
    console.error(err);
    return twilioWs.close();
  }

  openaiWs.on("message", data => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === "response.audio.delta" && event.delta && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify({ event: "media", streamSid: twilioWs.streamSid, media: { payload: event.delta } }));
      }
    } catch (e) { console.error(e); }
  });

  twilioWs.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "start") twilioWs.streamSid = msg.start.streamSid;
      if (msg.event === "media" && msg.media?.payload && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
      }
      if (msg.event === "stop") openaiWs.close();
    } catch (e) { console.error(e); }
  });

  const close = () => { try { openaiWs?.close(); } catch {} };
  twilioWs.on("close", close);
  twilioWs.on("error", close);
});
