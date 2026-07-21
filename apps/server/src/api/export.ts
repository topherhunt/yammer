// Document export. ".md" is the raw text; ".docx" is converted purely in JS:
// marked (markdown -> HTML) piped into html-to-docx (HTML -> .docx). No pandoc,
// no system binary (plan.md sec 5).

import { marked } from "marked";
import HTMLtoDOCX from "html-to-docx";
import { sanitizeFilename } from "./validation";

export interface ExportedFile {
  filename: string;
  contentType: string;
  body: string | ArrayBuffer;
}

const DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function exportDocument(
  name: string,
  text: string,
  format: "md" | "docx",
): Promise<ExportedFile> {
  const base = sanitizeFilename(name);

  if (format === "md") {
    return {
      filename: `${base}.md`,
      contentType: "text/markdown; charset=utf-8",
      body: text,
    };
  }

  const html = await marked.parse(text);
  const docx = await HTMLtoDOCX(html, null, {});
  const body = await toArrayBuffer(docx);

  return { filename: `${base}.docx`, contentType: DOCX_CONTENT_TYPE, body };
}

async function toArrayBuffer(
  docx: Buffer | ArrayBuffer | Blob,
): Promise<ArrayBuffer> {
  if (docx instanceof ArrayBuffer) return docx;
  if (Buffer.isBuffer(docx)) {
    return docx.buffer.slice(
      docx.byteOffset,
      docx.byteOffset + docx.byteLength,
    ) as ArrayBuffer;
  }
  return docx.arrayBuffer();
}
