import { z } from 'zod';

const userSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().min(1),
});

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET muss mindestens 32 Zeichen haben'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET muss mindestens 32 Zeichen haben'),
  USERS_JSON: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'USERS_JSON ist kein valides JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.array(userSchema).min(1, 'USERS_JSON muss mindestens einen Nutzer enthalten')),
  ACCESS_TOKEN_TTL: z.coerce.number().int().min(5).default(3600),
  REFRESH_TOKEN_TTL: z.coerce.number().int().min(60).default(2592000),
  STATE_FILE: z.string().min(1).optional(),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Ungültige Konfiguration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

const isHttps = env.BASE_URL.startsWith('https://');
const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.BASE_URL);

if (!isHttps && !isLocalhost) {
  console.warn(`⚠️  BASE_URL (${env.BASE_URL}) ist kein HTTPS und kein localhost — Notion wird den Server nicht akzeptieren.`);
}

export const config = Object.freeze({
  ...env,
  /** Öffentliche URL der MCP-Resource (RFC 8707 resource indicator) */
  MCP_RESOURCE: `${env.BASE_URL}/mcp`,
  /** Öffentliche URL des PRM-Dokuments */
  PRM_URL: `${env.BASE_URL}/.well-known/oauth-protected-resource`,
  isHttps,
});
