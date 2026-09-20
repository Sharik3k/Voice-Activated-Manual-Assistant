import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";

export const runtime = "nodejs";

type ChatHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

type DocumentAnswer = {
  spoken_answer: string;
  visible_quote: string;
  page_reference: string;
  found_in_document: boolean;
};

function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set. Add it to your .env.local file.");
  }
  return new OpenAI({ apiKey });
}

const UNCLEAR_AUDIO_ANSWER: DocumentAnswer = {
  spoken_answer: "I didn't catch that. Could you please repeat?",
  visible_quote: "",
  page_reference: "",
  found_in_document: false,
};

/** Detect empty / silence hallucinations from Whisper (e.g. "MBC...", "You", "Thank you"). */
function isLikelyWhisperHallucination(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned) return true;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;

  const lower = cleaned.toLowerCase();
  if (lower.includes("mbc")) return true;
  if (lower.includes("thank you")) return true;

  // Whole-utterance "You" (punctuation ignored) — common silence hallucination
  const stripped = lower.replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  if (stripped === "you") return true;

  return false;
}

function buildSystemPrompt(documentText: string): string {
  return `You are a Voice-Activated Manual Assistant. You answer questions ONLY using the equipment manual text below.

RULES:
1. Use ONLY the document text. Do not invent facts, procedures, or numbers.
2. Prefer short, conversational spoken answers (1–3 sentences).
3. If the answer is in the document, set found_in_document to true and copy an EXACT sentence or short contiguous phrase into visible_quote (verbatim from the document).
4. For page_reference, use the number from the nearest "--- Page N ---" marker in the document text. Return just the number as a string (e.g. "3"). If unknown, use "".
5. If the answer is not in the document, set found_in_document to false, visible_quote to "", page_reference to "", and spoken_answer to a brief polite message that you could not find it in the manual.
6. Critically analyze the provided conversation history. If the user's latest question contains pronouns (e.g., "it", "its", "this model"), resolve them to the specific product mentioned in the previous messages before searching the document text.
7. You MUST respond with a single JSON object and nothing else. No markdown fences.

Required JSON shape:
{
  "spoken_answer": "Short conversational answer",
  "visible_quote": "Exact sentence from the text. Empty if not found.",
  "page_reference": "Page number. Empty if not found.",
  "found_in_document": true
}

--- MANUAL DOCUMENT TEXT ---
${documentText}
--- END OF DOCUMENT ---`;
}

function parseAnswerJson(raw: string): DocumentAnswer {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const parsed = JSON.parse(cleaned) as Partial<DocumentAnswer>;

  return {
    spoken_answer:
      typeof parsed.spoken_answer === "string"
        ? parsed.spoken_answer
        : "I could not generate an answer.",
    visible_quote:
      typeof parsed.visible_quote === "string" ? parsed.visible_quote : "",
    page_reference:
      typeof parsed.page_reference === "string" ? parsed.page_reference : "",
    found_in_document: Boolean(parsed.found_in_document),
  };
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const documentText = formData.get("documentText");
    const historyRaw = formData.get("history");

    if (!audio || !(audio instanceof File)) {
      return NextResponse.json(
        { error: "No audio file provided under the 'audio' field." },
        { status: 400 }
      );
    }

    if (typeof documentText !== "string" || !documentText.trim()) {
      return NextResponse.json(
        { error: "Missing documentText. Upload and parse a PDF first." },
        { status: 400 }
      );
    }

    let history: ChatHistoryItem[] = [];
    if (typeof historyRaw === "string" && historyRaw.trim()) {
      try {
        const parsed = JSON.parse(historyRaw) as ChatHistoryItem[];
        if (Array.isArray(parsed)) {
          history = parsed.filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          );
        }
      } catch {
        return NextResponse.json(
          { error: "Invalid history JSON." },
          { status: 400 }
        );
      }
    }

    const openai = getOpenAI();

    // Step 1: Speech-to-text (Whisper)
    const audioBytes = Buffer.from(await audio.arrayBuffer());

    if (audioBytes.byteLength < 100) {
      return NextResponse.json(
        { error: "Audio recording was too short or empty. Hold the button longer and try again." },
        { status: 400 }
      );
    }

    const originalName = audio.name || "recording.webm";
    const extension = originalName.includes(".")
      ? originalName.split(".").pop()!.toLowerCase()
      : audio.type.includes("wav")
        ? "wav"
        : audio.type.includes("mp4")
          ? "mp4"
          : "webm";

    const mimeByExt: Record<string, string> = {
      wav: "audio/wav",
      webm: "audio/webm",
      mp4: "audio/mp4",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      ogg: "audio/ogg",
      mpeg: "audio/mpeg",
    };

    const whisperFile = await toFile(audioBytes, `question.${extension}`, {
      type: audio.type || mimeByExt[extension] || "application/octet-stream",
    });

    const transcription = await openai.audio.transcriptions.create({
      file: whisperFile,
      model: "whisper-1",
    });

    const question = transcription.text?.trim() || "";
    if (!question) {
      return NextResponse.json(
        { error: "Could not transcribe any speech from the audio." },
        { status: 400 }
      );
    }

    // Guard: Whisper often hallucinates short noise/silence as "MBC", "You", "Thank you", etc.
    let answer: DocumentAnswer;
    if (isLikelyWhisperHallucination(question)) {
      answer = UNCLEAR_AUDIO_ANSWER;
    } else {
      // Step 2: Reason over full document context
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: buildSystemPrompt(documentText) },
          ...history.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
          { role: "user", content: question },
        ],
      });

      const rawContent = completion.choices[0]?.message?.content;
      if (!rawContent) {
        return NextResponse.json(
          { error: "Model returned an empty response." },
          { status: 502 }
        );
      }

      try {
        answer = parseAnswerJson(rawContent);
      } catch {
        return NextResponse.json(
          { error: "Failed to parse model JSON response.", raw: rawContent },
          { status: 502 }
        );
      }
    }

    // Step 3: Text-to-speech
    const speech = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: answer.spoken_answer,
      response_format: "mp3",
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());
    const audioBase64 = audioBuffer.toString("base64");

    return NextResponse.json({
      transcription: question,
      answer,
      audioBase64,
      audioMimeType: "audio/mpeg",
    });
  } catch (error) {
    console.error("ask error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Something went wrong while processing your question.",
      },
      { status: 500 }
    );
  }
}
