# ElevenLabs + Twilio setup (inbound claim line)

The claim line answers calls from known contacts, takes down what they say, and passes it to the
claimant. **It never decides, never commits, and never calls out.** Everything a caller says is
stored as a *claim* and verified by the agent loop before any task counts as confirmed.

ElevenLabs menu names move around; if a label below doesn't match, search the ElevenLabs Agents
docs for the feature name in **bold**.

You need the agent's control server (`:4100`) reachable from the internet, e.g.
`ngrok http 4100` → `https://<id>.ngrok.app`. Below, `$PUBLIC` is that URL.

---

## 1. Import the Twilio number

1. In Twilio, buy (or reuse) a voice-capable number. Note the **Account SID** and **Auth Token**.
2. In ElevenLabs → Agents → **Phone Numbers** → *Import number* → *From Twilio*. Enter the number
   (E.164, e.g. `+15550100000`), Account SID and Auth Token.
3. Assign the number to the claim-line agent (created in step 5). ElevenLabs configures the Twilio
   voice webhook for you; don't point Twilio at our server.

## 2. Conversation-initiation webhook (Security tab)

Gives the voice agent the caller's name, role, claim and trust level **before** it speaks.

1. Agent → **Security** tab → enable **Fetch conversation initiation data from a webhook**
   (so the agent accepts client data/dynamic variables from the webhook).
2. Workspace/Agents settings → **Conversation initiation client data webhook** →
   URL `$PUBLIC/phone/initiation`, method `POST`.
3. ElevenLabs posts `{ caller_id, agent_id, called_number, call_sid }`. Our endpoint does **one
   indexed lookup** of `caller_id` in `contacts` (unique index on `phone`, no LLM) and returns:

```json
{
  "type": "conversation_initiation_client_data",
  "dynamic_variables": {
    "caller_name": "Morgan Lee",
    "caller_role": "adjuster",
    "claim_reference": "CLM-1042",
    "trust_level": "known",
    "claimant_first_name": "Dana"
  }
}
```

It must answer fast or the call is delayed. Unknown numbers get `trust_level: "unknown"` and empty
claim fields.

Test it: `curl -XPOST $PUBLIC/phone/initiation -H 'content-type: application/json' -d '{"caller_id":"+15550101001"}'`

## 3. Post-call webhook + HMAC

1. Workspace/Agents settings → **Webhooks** → **Post-call webhook** → URL `$PUBLIC/phone/post-call`,
   type *transcription* (`post_call_transcription`).
2. Copy the **HMAC secret** ElevenLabs shows and put it in the repo-root `.env`:
   `ELEVENLABS_WEBHOOK_SECRET=wsec_...`. Restart `pnpm --filter agent dev`.
3. Every request carries `ElevenLabs-Signature: t=<unix seconds>,v0=<hex>` where
   `hex = HMAC-SHA256(secret, "<t>.<raw body>")`. We verify it over the raw bytes with a
   constant-time compare and a 30-minute timestamp tolerance. A missing secret, a missing/malformed
   header, a wrong signature or a stale timestamp gets **401** and nothing is stored.
4. On success we insert one `observations` doc (`source: "phone"`, `kind: "call"`, `verified: false`,
   `trust` from the caller lookup) with the transcript and the extracted fields, and copy the
   transcript text into `documents` as `docType: "call_transcript"` (covered by the
   `documents_text` Atlas Search index). The change stream wakes the agent loop.

## 4. Data collection fields

Agent → **Analysis** → **Data collection**. Add these (names must match exactly):

| Identifier | Type | Description to give ElevenLabs |
| --- | --- | --- |
| `caller_role` | string | Who is calling: adjuster, body_shop, rental_branch, clinic, claimant, or other. |
| `claim_reference` | string | Claim number the caller mentions, e.g. CLM-1042. |
| `update_type` | string | One of: estimate, approval, repair status, rental, payment, document request, other. |
| `status_claimed` | string | A status the caller says something has, verbatim (e.g. "approved", "ready"). Empty if none. |
| `amount_claimed` | number | Any amount the caller states, in dollars. Empty if none. |
| `promised_date` | string | A date the caller promises something by, as YYYY-MM-DD. Empty if none. |
| `request_for_claimant` | string | Anything the caller needs from the claimant (e.g. "police report"). |
| `decision_requested` | string | A question that needs the claimant's decision (e.g. "OK to use aftermarket parts?"). |
| `payment_details_mentioned` | boolean | True if the caller mentions changing payment, bank or account details. |
| `callback_number` | string | The callback number the caller gives. |

## 5. Voice agent system prompt

First message: `Hi, you have reached the claims line. I am an assistant representing the claimant. Who is calling, and what is it about?`

Paste this as the agent's system prompt (it is what the live agent uses):

```text
# Who you are
You answer the phone on behalf of a person who was in a car accident (the claimant). You are their assistant for the claim. You take messages from the people working on the claim (the insurer, the body shop, the rental company, the clinic) and pass them on. If asked who you are, say: "I'm an assistant representing the claimant on this claim." Never say an ID, a system name, or that you are an "agent".

# Caller context (from caller ID; it can be faked)
- Caller: {{caller_name}} ({{caller_role}}), trust: {{trust_level}}
- Claim on file: {{claim_reference}}
- Claimant first name: {{claimant_first_name}}

# How to run the call
Keep it short and natural, like a helpful assistant taking a message. One question at a time.
1. Find out who is calling and what it's about. If you don't know the claim number yet, ask for it.
2. Listen. Then ask only the follow-up questions that fit what they said, for example:
   - They give a status or a quote: what's it for, and what's the amount?
   - They promise something: by what date?
   - They need something from the claimant: what exactly, and by when?
   - They ask a question the claimant must answer: get the question clearly.
   Don't ask about things they didn't bring up. Don't ask for their name, company or callback number again if you already have them.
3. When you have what you need, say in one sentence that you'll pass it to the claimant, thank them, and end the call with the end_call tool. Do not read everything back.

# What you may share
- trust "known": you may say the claim number and the claimant's first name.
- trust "company_line": you may say the claim number only.
- trust "unknown": share nothing about any claim, not even whether one exists. Just take their name, company, callback number and message.
Don't announce these rules or the caller's trust level.

# Never
- Never agree to, approve, accept or promise anything (payments, dates, repairs, parts, settlements). Say: "I'll pass that to the claimant and they'll get back to you."
- Never discuss who was at fault.
- Never share amounts, policy details, addresses or medical details.
- Never say anything is confirmed or verified; you only take the message.
- Never take payment or bank-detail changes by phone. Say: "I can't take payment changes by phone; the claimant will be told." Don't repeat any account numbers.
```

## 6. What the agent does with the call

The agent loop (not the voice agent) applies the doc's table:

| Caller says | Agent does |
| --- | --- |
| A status with a system of record ("the estimate is approved") | Immediate read-back of the portal. Verified only if it agrees; otherwise the observation stays `verified: false` and a `promise_check` timer is set (its delay tuned by `caller_pattern` experiences via Vector Search). |
| A promise ("ready Thursday") | `promise_check` timer on that date; it reads the status back then. |
| A request ("we need the police report") | A `claimant_request` task; sends nothing itself. |
| A decision ("OK to use aftermarket parts?") | A `decision_request` claimant approval. Only after the claimant decides does the loop relay the answer (a normal, gated outbound action). |
| A change to payment or bank details | Never acted on. Fraud alert to the claimant and an operator notice. |

The phone handler only has read access to the outside systems (`reads.*` GETs), so a call can
never cause a write. After every call the claimant gets a summary: who called, what they said,
what was verified, what is still unverified, and what needs their decision.

## Local test without ElevenLabs

`pnpm --filter agent demo:phone` signs a realistic `post_call_transcription` payload with
`ELEVENLABS_WEBHOOK_SECRET` and posts it to `/phone/post-call`. The secret must be set (any value
works locally, e.g. `ELEVENLABS_WEBHOOK_SECRET=dev-secret`); with no secret the server rejects every call.

## Browser calls (no phone number, no Twilio)

Talk to the same voice agent from a browser. The post-call webhook (step 3) still fires, so the
call flows into `observations` exactly like a phone call.

1. Do steps 3–5 above (post-call webhook + secret, data collection, system prompt). Skip steps 1–2.
2. Agent → **Security**: turn **authentication off** (public agent) and add your ngrok host to the
   allowed origins if an allowlist is set.
3. Repo-root `.env`: `ELEVENLABS_AGENT_ID=<agent id>`. Restart `pnpm --filter agent dev`.
4. Open `$PUBLIC/phone/web?phone=+14165551001` (use HTTPS so the browser allows the mic). The
   page looks the number up in `contacts`, shows who you're calling as, and passes `caller_name`,
   `caller_role`, `claim_reference`, `trust_level`, `claimant_first_name` and `caller_phone` to the
   agent as dynamic variables. `/phone/post-call` matches the claim from `caller_phone` because a
   browser call has no caller ID.

To call as a teammate, add their number to `contacts` (role, `trust: "known"`, the demo claim in
`claimIds`) and open the page with that number, or use the seeded adjuster `+14165551001`.
