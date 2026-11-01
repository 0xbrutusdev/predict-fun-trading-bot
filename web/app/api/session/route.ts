import {
  authenticated,
  config,
  json,
  login,
  logout,
} from "../../../lib/gateway";
export const runtime = "nodejs";
export async function GET(req: Request) {
  const c = config();
  return json({
    data: {
      authenticated: authenticated(req, c),
      configured: !!c.key && c.key.length >= 32,
    },
  });
}
export const POST = (req: Request) => login(req);
export const DELETE = (req: Request) => logout(req);
