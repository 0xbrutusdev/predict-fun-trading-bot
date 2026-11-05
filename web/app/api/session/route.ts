import {
  authenticated,
  config,
  json,
  login,
  logout,
} from "../../../lib/gateway";
import { auth } from "../../../auth";
export const runtime = "nodejs";
export async function GET(req: Request) {
  const c = config(),
    authConfigured = Boolean(
      process.env.AUTH_SECRET &&
      process.env.AUTH_SECRET.length >= 32 &&
      process.env.AUTH_GITHUB_ID &&
      process.env.AUTH_GITHUB_SECRET,
    ),
    authSession = authConfigured ? await auth() : null;
  return json({
    data: {
      authenticated: Boolean(authSession?.user) || authenticated(req, c),
      configured: authConfigured || Boolean(c.key && c.key.length >= 32),
      authMode: authConfigured ? "authjs" : "legacy",
      tenantId: authSession?.user?.tenantId ?? null,
    },
  });
}
export const POST = (req: Request) => login(req);
export const DELETE = (req: Request) => logout(req);
