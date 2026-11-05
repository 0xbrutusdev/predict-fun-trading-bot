import { proxy } from "../../../../lib/gateway";
import { auth } from "../../../../auth";
export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ path: string[] }> };
async function handler(req: Request, context: Context) {
  const authConfigured = Boolean(
      process.env.AUTH_SECRET &&
      process.env.AUTH_SECRET.length >= 32 &&
      process.env.AUTH_GITHUB_ID &&
      process.env.AUTH_GITHUB_SECRET,
    ),
    session = authConfigured ? await auth() : null;
  return proxy(
    req,
    (await context.params).path.join("/"),
    undefined,
    fetch,
    session?.user
      ? {
          id: session.user.id,
          email: session.user.email,
          tenantId: session.user.tenantId,
        }
      : undefined,
  );
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT };
