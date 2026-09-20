# Voice-Activated Manual Assistant

Next.js 14 prototype: upload a short equipment PDF, ask questions with your microphone, get a spoken answer plus an exact quote and page reference.

## Setup

```bash
npm install
cp .env.example .env.local
# Put your OpenAI API key in .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Flow

1. Upload a PDF (max 10 pages) → `/api/parse-pdf`
2. Hold **Hold to Speak** → microphone records via `MediaRecorder`
3. Release → `/api/ask` runs Whisper → GPT-4o-mini (full document in context) → TTS
4. UI plays the audio and shows the quote when found
