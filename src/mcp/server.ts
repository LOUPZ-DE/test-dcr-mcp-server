import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from '../util/log.js';

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'test-dcr-mcp-server', version: '0.1.0' });

  // 1. whoami — verifiziert Identity-Passthrough: liest die Identität aus dem Bearer-Token
  server.registerTool(
    'whoami',
    {
      description: 'Gibt den authentifizierten Nutzer des MCP-Servers zurück',
      inputSchema: {},
    },
    async (_args, extra) => {
      const authInfo = extra.authInfo;
      if (!authInfo) {
        return { content: [{ type: 'text', text: 'unauthenticated (kein AuthInfo im Request)' }] };
      }
      const identity = {
        email: authInfo.extra?.email,
        name: authInfo.extra?.name,
        clientId: authInfo.clientId,
        scopes: authInfo.scopes,
        expiresAt: authInfo.expiresAt ? new Date(authInfo.expiresAt * 1000).toISOString() : undefined,
      };
      return { content: [{ type: 'text', text: JSON.stringify(identity, null, 2) }] };
    },
  );

  // 2. echo — verifiziert Argument-Übergabe
  server.registerTool(
    'echo',
    {
      description: 'Gibt den übergebenen Text zurück',
      inputSchema: { text: z.string().describe('Der Text, der zurückgegeben wird') },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );

  // 3. slow_task — verifiziert Timeout-Verhalten (honoriert Abort via extra.signal)
  server.registerTool(
    'slow_task',
    {
      description: 'Wartet n Sekunden und antwortet dann',
      inputSchema: {
        seconds: z.number().min(0).max(60).default(5).describe('Wartezeit in Sekunden (max. 60)'),
      },
    },
    async ({ seconds }, extra) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        if (extra.signal.aborted) {
          return { content: [{ type: 'text', text: `abgebrochen nach ${Math.round((seconds * 1000 - (deadline - Date.now())) / 1000)}s` }] };
        }
        await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
      }
      return { content: [{ type: 'text', text: `${seconds} Sekunden gewartet.` }] };
    },
  );

  return server;
}

/**
 * Stateless Streamable HTTP: pro Request frischer Server + Transport.
 * Kein Session-Store nötig — passt zum Container-Betrieb (horizontal skalierbar, sticky-frei).
 */
export async function mcpPostHandler(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    // req.auth (von requireBearerAuth gesetzt) reicht der Transport als authInfo an die Tool-Handler durch.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log('error', 'Fehler im MCP-Transport', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

/** Stateless = kein Standalone-SSE-Stream und kein Session-Terminate → spec-konform 405. */
export function mcpMethodNotAllowedHandler(_req: Request, res: Response): void {
  res
    .set('Allow', 'POST')
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: nur POST /mcp).' }, id: null });
}
