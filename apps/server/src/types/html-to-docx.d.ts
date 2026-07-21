// html-to-docx ships no type declarations. Minimal ambient module for the one
// call we make: markdown -> HTML (marked) -> .docx (html-to-docx), pure JS.
declare module "html-to-docx" {
  export default function htmlToDocx(
    htmlString: string,
    headerHTMLString?: string | null,
    documentOptions?: Record<string, unknown>,
    footerHTMLString?: string | null,
  ): Promise<Buffer | ArrayBuffer | Blob>;
}
