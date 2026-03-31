/**
 * @8gent/auth — CLI Auth Server
 *
 * Spins up a temporary local HTTP server to receive auth tokens from the browser.
 * This is the Claude Code / gh auth login pattern:
 *
 * 1. CLI starts local server on a random port
 * 2. Opens browser to 8gent.app/auth/cli?port=XXXX&state=YYYY
 * 3. User signs in via Clerk on the web
 * 4. After sign-in, browser JS POSTs the session token to localhost:XXXX/callback
 * 5. CLI receives token, stores it, closes server
 */

import { randomBytes } from "crypto";

export interface CLIAuthResult {
  success: boolean;
  token?: string;
  userId?: string;
  email?: string;
  displayName?: string;
  error?: string;
}

export interface CLIAuthCallbacks {
  onServerReady?: (url: string, port: number) => void;
  onBrowserOpened?: () => void;
  onWaiting?: () => void;
  onTokenReceived?: (result: CLIAuthResult) => void;
  onError?: (error: string) => void;
  onTimeout?: () => void;
}

/**
 * Run the CLI auth flow:
 * - Start local server
 * - Open browser
 * - Wait for callback
 * - Return token
 */
export async function runCLIAuthFlow(
  webBaseUrl: string = "https://8gent.app",
  callbacks?: CLIAuthCallbacks,
  timeoutMs: number = 5 * 60 * 1000, // 5 min
): Promise<CLIAuthResult> {
  const state = randomBytes(16).toString("hex");
  let resolved = false;

  return new Promise<CLIAuthResult>((resolve) => {
    // Start local HTTP server
    const server = Bun.serve({
      port: 0, // random available port
      async fetch(req) {
        const url = new URL(req.url);

        // CORS preflight
        if (req.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "POST, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type",
            },
          });
        }

        // Auth callback from browser
        if (url.pathname === "/callback" && req.method === "POST") {
          try {
            const body = await req.json() as {
              token?: string;
              userId?: string;
              email?: string;
              displayName?: string;
              state?: string;
            };

            // Verify state to prevent CSRF
            if (body.state !== state) {
              return new Response(JSON.stringify({ error: "Invalid state" }), {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }

            const result: CLIAuthResult = {
              success: true,
              token: body.token,
              userId: body.userId,
              email: body.email,
              displayName: body.displayName,
            };

            resolved = true;
            callbacks?.onTokenReceived?.(result);

            // Close server after short delay (let response complete)
            setTimeout(() => {
              server.stop();
              resolve(result);
            }, 500);

            return new Response(
              JSON.stringify({ ok: true, message: "Authentication successful. You can close this tab." }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              },
            );
          } catch {
            return new Response(JSON.stringify({ error: "Invalid request" }), {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }

        return new Response("Not found", { status: 404 });
      },
    });

    const port = server.port;
    const authUrl = `${webBaseUrl}/auth/cli?port=${port}&state=${state}`;

    callbacks?.onServerReady?.(authUrl, port);

    // Auto-open browser
    try {
      const proc = Bun.spawn(["open", authUrl], { stdout: "ignore", stderr: "ignore" });
      proc.exited.then(() => callbacks?.onBrowserOpened?.());
    } catch {
      // If open fails, user can manually visit the URL
    }

    callbacks?.onWaiting?.();

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.stop();
        callbacks?.onTimeout?.();
        resolve({ success: false, error: "Authentication timed out. Please try again." });
      }
    }, timeoutMs);
  });
}
