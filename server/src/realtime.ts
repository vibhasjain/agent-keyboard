// Mint a short-lived OpenAI Realtime client secret so the widget can open a
// WebRTC/WebSocket transcription session (push-to-talk voice → text in the
// prompt bar) without ever seeing our OpenAI key. Configured for transcription
// (push-to-talk speech-to-text, no audio playback).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const TRANSCRIBE_MODEL = process.env.REALTIME_TRANSCRIBE_MODEL ?? "gpt-4o-transcribe";
const FALLBACK = process.env.REALTIME_FALLBACK === "1";

export interface RealtimeToken {
  value: string;
  expires_at: number | null;
  session_type: string;
}

/** Body for the primary transcription-only session. */
function transcriptionBody() {
  return {
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription: { model: TRANSCRIBE_MODEL, language: "en" },
          turn_detection: { type: "server_vad", silence_duration_ms: 600 },
          noise_reduction: { type: "near_field" },
        },
      },
    },
  };
}

/** Body for a neutered realtime session (fallback where "transcription" type is unavailable). */
function fallbackBody() {
  return {
    session: {
      type: "realtime",
      model: "gpt-realtime",
      output_modalities: ["text"],
      audio: {
        input: {
          transcription: { model: "gpt-4o-transcribe" },
          turn_detection: { type: "server_vad", create_response: false, interrupt_response: false },
        },
      },
    },
  };
}

export async function mintRealtimeToken(): Promise<
  RealtimeToken | { error: string; detail?: unknown }
> {
  if (!OPENAI_API_KEY) return { error: "voice_not_configured" };

  const body = FALLBACK ? fallbackBody() : transcriptionBody();
  const sessionType = body.session.type;
  try {
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as {
      value?: string;
      client_secret?: { value?: string };
      expires_at?: number;
    };
    if (resp.status >= 400) return { error: "mint_failed", detail: data };
    const value = data.value ?? data.client_secret?.value;
    if (!value) return { error: "mint_failed", detail: data };
    return { value, expires_at: data.expires_at ?? null, session_type: sessionType };
  } catch (err) {
    return { error: "openai_unreachable", detail: String(err) };
  }
}
