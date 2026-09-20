"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  blobToWav,
  extensionForMimeType,
  pickRecorderMimeType,
} from "@/lib/audio";

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

type Exchange = {
  id: string;
  question: string;
  answer: DocumentAnswer;
};

function releaseStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function HomePage() {
  const [documentText, setDocumentText] = useState("");
  const [fileName, setFileName] = useState("");
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [history, setHistory] = useState<ChatHistoryItem[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [status, setStatus] = useState("Upload a PDF manual to get started.");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    return () => {
      releaseStream(streamRef.current);
      streamRef.current = null;
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const playBase64Audio = useCallback((base64: string, mimeType: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const audio = new Audio(`data:${mimeType};base64,${base64}`);
    audioRef.current = audio;
    void audio.play().catch(() => {
      alert("Could not play the spoken answer. Check your device audio settings.");
    });
  }, []);

  async function handlePdfUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setStatus("Parsing PDF…");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json()) as {
        text?: string;
        pageCount?: number;
        fileName?: string;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || "Failed to parse PDF.");
      }

      setDocumentText(data.text || "");
      setFileName(data.fileName || file.name);
      setPageCount(data.pageCount ?? null);
      setHistory([]);
      setExchanges([]);
      setStatus("Manual loaded. Hold the button and ask a question.");
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "PDF upload failed.");
      setStatus("Upload failed. Try another PDF (max 10 pages).");
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }

  async function processAudio() {
    if (audioChunksRef.current.length === 0) {
      setStatus("Ready. Hold to speak.");
      return;
    }

    if (!documentText) {
      alert("Please upload a PDF manual first.");
      return;
    }

    const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
    const rawBlob = new Blob(audioChunksRef.current, { type: mimeType });
    audioChunksRef.current = [];

    if (rawBlob.size === 0) {
      alert("No audio was captured. Please try again.");
      setStatus("Ready. Hold to speak.");
      return;
    }

    setAsking(true);
    setStatus("Transcribing and answering…");

    try {
      // Re-encode to WAV so Whisper always receives a complete, supported file.
      // Raw MediaRecorder WebM is often truncated/corrupt on the 2nd+ recording.
      let uploadBlob: Blob;
      let filename = "recording.wav";
      try {
        uploadBlob = await blobToWav(rawBlob);
      } catch (decodeError) {
        console.warn("WAV conversion failed, uploading raw recording:", decodeError);
        const ext = extensionForMimeType(mimeType);
        uploadBlob = rawBlob;
        filename = `recording.${ext}`;
      }

      const formData = new FormData();
      formData.append("audio", uploadBlob, filename);
      formData.append("documentText", documentText);
      formData.append("history", JSON.stringify(history));

      const res = await fetch("/api/ask", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json()) as {
        transcription?: string;
        answer?: DocumentAnswer;
        audioBase64?: string;
        audioMimeType?: string;
        error?: string;
      };

      if (!res.ok || !data.transcription || !data.answer || !data.audioBase64) {
        throw new Error(data.error || "Ask request failed.");
      }

      const exchange: Exchange = {
        id: `${Date.now()}`,
        question: data.transcription,
        answer: data.answer,
      };

      setExchanges((prev) => [...prev, exchange]);
      setHistory((prev) => [
        ...prev,
        { role: "user", content: data.transcription! },
        { role: "assistant", content: data.answer!.spoken_answer },
      ]);

      playBase64Audio(data.audioBase64, data.audioMimeType || "audio/mpeg");
      setStatus("Ready for another question. Hold to speak.");
    } catch (error) {
      console.error(error);
      alert(error instanceof Error ? error.message : "Failed to process your question.");
      setStatus("Something went wrong. You can try again.");
    } finally {
      setAsking(false);
    }
  }

  async function startRecording() {
    if (!documentText) {
      alert("Please upload a PDF manual first.");
      return;
    }
    if (asking || recording || stoppingRef.current) return;

    try {
      audioChunksRef.current = [];

      // Always request a fresh mic stream for each take.
      releaseStream(streamRef.current);
      streamRef.current = null;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const mimeType = pickRecorderMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        // Release the mic only after MediaRecorder has flushed its final chunk.
        releaseStream(streamRef.current);
        streamRef.current = null;
        stoppingRef.current = false;
        void processAudio();
      };

      recorder.onerror = () => {
        releaseStream(streamRef.current);
        streamRef.current = null;
        stoppingRef.current = false;
        setRecording(false);
        setStatus("Recording failed. Try again.");
      };

      // Timeslice ensures we get periodic chunks + a valid container on stop.
      recorder.start(250);
      setRecording(true);
      setStatus("Listening… release when finished.");
    } catch (error) {
      console.error(error);
      releaseStream(streamRef.current);
      streamRef.current = null;
      alert(
        "Microphone access was denied or unavailable. Allow mic permissions and try again."
      );
      setStatus("Microphone unavailable.");
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive" || stoppingRef.current) {
      setRecording(false);
      return;
    }

    stoppingRef.current = true;
    setRecording(false);

    // Flush buffered data, then stop. Do NOT stop tracks here —
    // killing the stream before onstop truncates the WebM and Whisper rejects it.
    try {
      if (recorder.state === "recording") {
        recorder.requestData();
      }
      recorder.stop();
    } catch (error) {
      console.error(error);
      stoppingRef.current = false;
      releaseStream(streamRef.current);
      streamRef.current = null;
    }
  }

  const ready = Boolean(documentText);

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-10">
      <header className="mb-8">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Prototype
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
          Voice-Activated Manual Assistant
        </h1>
        <p className="mt-2 text-slate-600">
          Upload a short equipment manual (PDF, max 10 pages), then hold the
          button and ask a question aloud.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <label className="block text-sm font-medium text-slate-700">
          Equipment manual (PDF)
        </label>
        <input
          type="file"
          accept="application/pdf,.pdf"
          onChange={handlePdfUpload}
          disabled={uploading || asking || recording}
          className="mt-2 block w-full text-sm text-slate-600 file:mr-4 file:rounded-lg file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800 disabled:opacity-50"
        />

        {fileName && (
          <p className="mt-3 text-sm text-slate-600">
            Loaded: <span className="font-medium text-slate-900">{fileName}</span>
            {pageCount !== null ? ` · ${pageCount} page${pageCount === 1 ? "" : "s"}` : ""}
          </p>
        )}

        <p className="mt-4 text-sm text-slate-500" aria-live="polite">
          {status}
        </p>

        <div className="mt-6 flex flex-col items-center gap-3">
          <button
            type="button"
            disabled={!ready || uploading || asking}
            onPointerDown={(e) => {
              e.preventDefault();
              void startRecording();
            }}
            onPointerUp={(e) => {
              e.preventDefault();
              stopRecording();
            }}
            onPointerCancel={() => {
              stopRecording();
            }}
            onPointerLeave={() => {
              if (recording) stopRecording();
            }}
            className={`select-none rounded-full px-10 py-5 text-base font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40 ${
              recording
                ? "bg-red-600 focus-visible:ring-red-500"
                : "bg-slate-900 hover:bg-slate-800 focus-visible:ring-slate-500"
            }`}
          >
            {asking ? "Thinking…" : recording ? "Listening… release" : "Hold to Speak"}
          </button>
          <p className="text-xs text-slate-400">
            Press and hold · release to send
          </p>
        </div>
      </section>

      <section className="mt-8 space-y-4">
        {exchanges.length === 0 ? (
          <p className="text-center text-sm text-slate-400">
            Conversation will appear here.
          </p>
        ) : (
          exchanges.map((item) => (
            <article
              key={item.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                You asked
              </p>
              <p className="mt-1 text-slate-900">{item.question}</p>

              <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
                Answer
              </p>
              <p className="mt-1 text-slate-800">{item.answer.spoken_answer}</p>

              {item.answer.found_in_document && item.answer.visible_quote && (
                <blockquote className="mt-4 border-l-4 border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                  <p className="italic">&ldquo;{item.answer.visible_quote}&rdquo;</p>
                  {item.answer.page_reference && (
                    <footer className="mt-2 text-xs font-medium not-italic text-slate-500">
                      Page {item.answer.page_reference}
                    </footer>
                  )}
                </blockquote>
              )}

              {!item.answer.found_in_document && (
                <p className="mt-3 text-xs text-amber-700">
                  Not found as an exact match in the uploaded manual.
                </p>
              )}
            </article>
          ))
        )}
      </section>
    </main>
  );
}
