import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Admin dashboard middleware.
 *
 * 1. All routes require Clerk authentication.
 * 2. All routes require admin role (publicMetadata.role === "admin").
 * 3. Unauthenticated users are redirected to /sign-in.
 * 4. Non-admin users see a 403 response.
 */

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // Allow public routes without auth
  if (isPublicRoute(req)) {
    return NextResponse.next();
  }

  // Require authentication for all other routes
  const session = await auth();

  if (!session.userId) {
    const signInUrl = new URL("/sign-in", req.url);
    signInUrl.searchParams.set("redirect_url", req.url);
    return NextResponse.redirect(signInUrl);
  }

  // Check admin role from session claims
  // Clerk stores publicMetadata in sessionClaims
  const metadata = session.sessionClaims?.metadata as
    | { role?: string }
    | undefined;
  const role = metadata?.role;

  if (role !== "admin") {
    return new NextResponse(
      JSON.stringify({
        error: "Forbidden",
        message: "Admin access required. Contact support if you believe this is an error.",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
