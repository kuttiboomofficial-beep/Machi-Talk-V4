# MACHI TALK V4.1 — Natural Real-time Translation Core

V4.1 is the cleaned-up prototype for the India-wide MACHI TALK vision. It keeps the target unchanged: natural, respectful, two-way spoken translation.

## Core target
- Tamil ↔ Hindi first
- Natural spoken language, not bookish language
- Preserve meaning, intent and respect
- Real-time voice output
- Architecture ready for a compliant telephony/SIP provider

## Important
This prototype does not intercept a normal Android SIM call. The current telephony adapter is Twilio-based and requires a compliant calling route. Twilio's current India voice guidelines state that outbound calls to Indian PSTN numbers can only be made from international (non-Indian) numbers, so do not buy a Twilio number for India-to-India production testing until a compliant carrier/SIP/BYOC route is confirmed.

## Environment
OPENAI_API_KEY=your_secret
OPENAI_REALTIME_MODEL=gpt-realtime-translate
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
PUBLIC_BASE_URL=https://your-server.example.com
PORT=3000

Never put secrets in GitHub or the browser.
