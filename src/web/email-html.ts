import type { Attachment } from "../shared/types";
import { unwrapGoogleRedirect } from "../shared/linkify";
import { collapseEmailQuotes } from "./email-quotes";

const BLOCKED_ELEMENTS = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
].join(",");

const DOCUMENT_STYLE = `
  :root { color-scheme: only light; }
  html { background: #fff; }
  body {
    display: flow-root;
    box-sizing: border-box;
    margin: 0;
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-wrap: anywhere;
    color: #172033;
    font-family: Arial, Helvetica, sans-serif;
    line-height: 1.5;
  }
  *, *::before, *::after { box-sizing: border-box; }
  table { max-width: 100% !important; }
  img { max-width: 100% !important; height: auto; }
  a { overflow-wrap: anywhere; }
  details.mailroom-quoted-text { margin: 12px 0 0; }
  details.mailroom-quoted-text > summary {
    width: fit-content;
    padding: 4px 0;
    color: #626775;
    font: 12px/20px Arial, Helvetica, sans-serif;
    cursor: pointer;
  }
  details.mailroom-quoted-text > summary:hover { color: #172033; }
  details.mailroom-quoted-text > summary:focus-visible {
    outline: 2px solid #626775;
    outline-offset: 2px;
    border-radius: 2px;
  }
  details.mailroom-quoted-text:not([open]) > summary > .mailroom-hide-quote,
  details.mailroom-quoted-text[open] > summary > .mailroom-show-quote { display: none; }
`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' https: http: data:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

export function buildEmailHtmlDocument(html: string, attachments: Attachment[]): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "formaction" ||
        name === "action" ||
        name === "ping"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const attachmentsByContentId = new Map(
    attachments
      .filter((attachment) => attachment.content_id)
      .map((attachment) => [normalizeContentId(attachment.content_id!), attachment.id]),
  );

  for (const image of document.querySelectorAll("img")) {
    image.removeAttribute("srcset");
    image.setAttribute("loading", "lazy");
    image.setAttribute("referrerpolicy", "no-referrer");
    const source = image.getAttribute("src")?.trim() ?? "";
    if (/^cid:/i.test(source)) {
      const attachmentId = attachmentsByContentId.get(normalizeContentId(source.slice(4)));
      if (attachmentId) image.setAttribute("src", `/api/attachments/${attachmentId}`);
      else image.removeAttribute("src");
    } else if (!isAllowedImageSource(source)) {
      image.removeAttribute("src");
    }
  }

  for (const link of document.querySelectorAll("a, area")) {
    const original = link.getAttribute("href")?.trim() ?? "";
    const destination = safeLinkDestination(unwrapGoogleRedirect(
      original.startsWith("//") ? `https:${original}` : original,
    ));
    if (!destination) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      continue;
    }
    // Keep descriptive labels and images; shorten labels that are the raw wrapper URL.
    if (destination !== original && link.textContent?.trim() === original) {
      link.textContent = destination;
    }
    link.setAttribute("href", destination);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    link.removeAttribute("download");
  }

  collapseEmailQuotes(document);

  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = CONTENT_SECURITY_POLICY;
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  const style = document.createElement("style");
  style.textContent = DOCUMENT_STYLE;
  document.head.prepend(csp, referrer, viewport, style);

  return `<!doctype html>${document.documentElement.outerHTML}`;
}

function normalizeContentId(value: string): string {
  const decoded = safeDecodeURIComponent(value.trim());
  return decoded.replace(/^<|>$/g, "").trim().toLowerCase();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isAllowedImageSource(value: string): boolean {
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeLinkDestination(value: string): string | null {
  const destination = value.trim();
  if (!destination) return null;
  if (destination.startsWith("#")) return destination;
  if (destination.startsWith("//")) return `https:${destination}`;
  try {
    const url = new URL(destination);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? destination
      : null;
  } catch {
    return null;
  }
}
