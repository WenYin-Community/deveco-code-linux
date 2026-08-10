import { marked, type Tokens } from "marked"

// Only allow link protocols that cannot execute script. http(s), mailto, tel,
// local fragments, and inline data images are safe; javascript:/vbscript: are
// not. Anything else is rewritten to "#" so a malicious link cannot fire from
// an innerHTML render.
const SAFE_HREF_PROTOCOLS = /^(?:https?:|mailto:|tel:|\/|#|data:image\/)/i;

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

const renderer = new marked.Renderer();

renderer.link = ({ href, title, text }: Tokens.Link) => {
  const safeHref = typeof href === 'string' && SAFE_HREF_PROTOCOLS.test(href) ? escapeAttr(href) : '#';
  const titleAttr = title ? ` title="${escapeAttr(title)}"` : '';
  return `<a href="${safeHref}"${titleAttr} class='external-link' target='_blank' rel="noopener noreferrer">${escapeText(text)}</a>`;
};

export function parseMarkdown(input: string) {
  return marked(input, {
    renderer,
    breaks: false,
    gfm: true,
  });
}
