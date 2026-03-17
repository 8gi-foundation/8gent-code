/**
 * @8gent/db — Clerk Auth Provider Configuration
 *
 * Configures Convex to accept JWTs from Clerk.
 * Clerk's issuer domain is used to validate tokens server-side.
 */

export default {
  providers: [
    {
      // Clerk is the sole auth provider for 8gent
      domain: process.env.CLERK_ISSUER_DOMAIN || "https://clerk.8gent.app",
      applicationID: "convex",
    },
  ],
};
