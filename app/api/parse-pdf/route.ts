import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_PAGES = 10;

// Import the lib entry directly to avoid pdf-parse's test-file side effect.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  dataBuffer: Buffer,
  options?: {
    pagerender?: (pageData: {
      getTextContent: () => Promise<{
        items: Array<{ str?: string }>;
      }>;
    }) => Promise<string>;
  }
) => Promise<{ text: string; numpages: number }>;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "No PDF file provided. Upload a file under the 'file' field." },
        { status: 400 }
      );
    }

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Invalid file type. Please upload a PDF." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let pageNumber = 0;
    const data = await pdfParse(buffer, {
      pagerender: async (pageData) => {
        pageNumber += 1;
        const content = await pageData.getTextContent();
        const strings = content.items
          .map((item) => (typeof item.str === "string" ? item.str : ""))
          .filter(Boolean);
        return `\n\n--- Page ${pageNumber} ---\n${strings.join(" ")}`;
      },
    });

    if (data.numpages > MAX_PAGES) {
      return NextResponse.json(
        {
          error: `PDF has ${data.numpages} pages. Maximum allowed is ${MAX_PAGES}.`,
        },
        { status: 400 }
      );
    }

    const text = (data.text || "").trim();

    if (!text) {
      return NextResponse.json(
        { error: "Could not extract any text from this PDF." },
        { status: 400 }
      );
    }

    return NextResponse.json({
      text,
      pageCount: data.numpages,
      fileName: file.name,
    });
  } catch (error) {
    console.error("parse-pdf error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to parse PDF. Please try another file.",
      },
      { status: 500 }
    );
  }
}
