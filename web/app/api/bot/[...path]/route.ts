import { proxy } from "../../../../lib/gateway";
export const runtime = "nodejs";
export const maxDuration = 15;
type Context = { params: Promise<{ path: string[] }> };
async function handler(req: Request, context: Context) {
  return proxy(req, (await context.params).path.join("/"));
}
export { handler as GET, handler as POST, handler as PATCH, handler as PUT };
