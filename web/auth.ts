import { createHash } from "node:crypto";
import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

const providers =
  process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET
    ? [
        GitHub({
          clientId: process.env.AUTH_GITHUB_ID,
          clientSecret: process.env.AUTH_GITHUB_SECRET,
        }),
      ]
    : [];

const tenantId = (identity: string) =>
  createHash("sha256")
    .update(identity.trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  callbacks: {
    jwt({ token, user }) {
      const identity = String(user?.email || token.email || token.sub || "");
      if (identity) token.tenantId = tenantId(identity);
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.sub || "");
        session.user.tenantId = String(token.tenantId || "");
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    tenantId?: string;
  }
}
