/** Geteilte HTML-Helfer für die server-gerenderten Seiten (Login-Form, Info-Seite). */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · test-dcr-mcp-server</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #1e293b; border-radius: 12px; padding: 2rem; width: 100%; max-width: 380px; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
  .card.wide { max-width: 560px; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .sub { color: #94a3b8; font-size: .85rem; margin-bottom: 1.5rem; }
  label { display: block; font-size: .8rem; color: #94a3b8; margin: .75rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .6rem .75rem; border-radius: 8px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 1rem; }
  input:focus { outline: 2px solid #38bdf8; border-color: transparent; }
  button { width: 100%; margin-top: 1.25rem; padding: .65rem; border: 0; border-radius: 8px; background: #38bdf8; color: #082f49; font-weight: 600; font-size: 1rem; cursor: pointer; }
  button:hover { background: #7dd3fc; }
  .error { background: #7f1d1d; color: #fecaca; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; margin-top: 1rem; }
  .meta { font-size: .75rem; color: #64748b; margin-top: 1.5rem; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: .8rem; margin-top: .75rem; }
  td { padding: .3rem .25rem; vertical-align: top; }
  td:first-child { color: #94a3b8; white-space: nowrap; padding-right: .75rem; }
  code, .url { color: #7dd3fc; word-break: break-all; font-family: ui-monospace, monospace; font-size: .78rem; }
  a { color: #7dd3fc; }
</style>
</head>
<body><div class="card">${body}</div></body>
</html>`;
}

/** Info-Seiten sind breiter als die Login-Karte. */
export function widePage(title: string, body: string): string {
  return page(title, body).replace('class="card"', 'class="card wide"');
}
