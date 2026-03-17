/**
 * @8gent/auth — Device Code Authorization Flow
 *
 * Implements RFC 8628 (OAuth 2.0 Device Authorization Grant) for CLI login.
 * This is the same pattern used by `gh auth login`, `az login`, and `gcloud auth login`.
 *
 * Flow:
 * 1. CLI requests a device code from the authorization server
 * 2. User visits a URL and enters the code in their browser
 * 3. CLI polls until the user approves (or the code expires)
 * 4. On approval, CLI receives an access token (JWT)
 */

import type {
  AuthConfig,
  DeviceAuthorizationResponse,
  DeviceTokenResponse,
  DeviceTokenErrorResponse,
  DeviceFlowState,
  AuthCallbacks,
} from "./types.js";

// ============================================
// Device Flow Orchestrator
// ============================================

/**
 * Execute the full device code authorization flow.
 *
 * @param config - Auth config with endpoints and client ID
 * @param callbacks - Optional callbacks for UI updates
 * @returns The final device flow state (completed, expired, denied, or error)
 */
export async function executeDeviceFlow(
  config: AuthConfig,
  callbacks?: AuthCallbacks,
): Promise<DeviceFlowState> {
  // Step 1: Request device code
  const authResponse = await requestDeviceAuthorization(config);
  if (!authResponse) {
    const state: DeviceFlowState = {
      phase: "error",
      error: "Failed to start device authorization. Check your network connection and Clerk configuration.",
    };
    callbacks?.onLoginError?.(state.error);
    return state;
  }

  // Step 2: Notify user with code and URL
  callbacks?.onDeviceCode?.(
    authResponse.user_code,
    authResponse.verification_uri_complete || authResponse.verification_uri,
  );

  // Step 3: Auto-open browser on macOS
  await openBrowser(
    authResponse.verification_uri_complete || authResponse.verification_uri,
  );

  // Step 4: Poll for token
  const result = await pollForToken(config, authResponse, callbacks);
  return result;
}

// ============================================
// Step 1: Request Device Authorization
// ============================================

async function requestDeviceAuthorization(
  config: AuthConfig,
): Promise<DeviceAuthorizationResponse | null> {
  try {
    const response = await fetch(config.deviceAuthEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.oauthClientId,
        scope: "openid profile email",
      }).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Device authorization failed (${response.status}): ${errorText}`,
      );
      return null;
    }

    return (await response.json()) as DeviceAuthorizationResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Device authorization request failed: ${message}`);
    return null;
  }
}

// ============================================
// Step 3: Auto-Open Browser
// ============================================

/**
 * Open a URL in the default browser.
 * Uses `open` on macOS, `xdg-open` on Linux, `start` on Windows.
 * Fails silently — the URL is always displayed for manual copy.
 */
async function openBrowser(url: string): Promise<void> {
  try {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "linux") {
      command = "xdg-open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      // Unknown platform — skip browser open
      return;
    }

    const proc = Bun.spawn([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // Don't await — we don't care if it succeeds
    proc.unref();
  } catch {
    // Silently fail — user can copy the URL manually
  }
}

// ============================================
// Step 4: Poll for Token
// ============================================

/**
 * Poll the token endpoint until the user approves, denies, or the code expires.
 *
 * Respects the server-specified polling interval and handles:
 * - `authorization_pending` — keep polling
 * - `slow_down` — increase interval by 5 seconds
 * - `expired_token` — code expired, flow failed
 * - `access_denied` — user denied, flow failed
 */
async function pollForToken(
  config: AuthConfig,
  authResponse: DeviceAuthorizationResponse,
  callbacks?: AuthCallbacks,
): Promise<DeviceFlowState> {
  let interval = authResponse.interval * 1000; // Convert to ms
  const deadline = Date.now() + Math.min(
    authResponse.expires_in * 1000,
    config.deviceFlowTimeoutMs,
  );
  let attempts = 0;

  while (Date.now() < deadline) {
    // Wait for the polling interval
    await sleep(interval);
    attempts++;

    callbacks?.onPollAttempt?.(attempts);

    try {
      const response = await fetch(config.deviceTokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.oauthClientId,
          device_code: authResponse.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });

      if (response.ok) {
        // Success — user approved
        const tokenData = (await response.json()) as DeviceTokenResponse;
        return {
          phase: "completed",
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
        };
      }

      // Parse error response
      const errorData = (await response.json()) as DeviceTokenErrorResponse;

      switch (errorData.error) {
        case "authorization_pending":
          // User hasn't approved yet — keep polling
          continue;

        case "slow_down":
          // Server asked us to slow down — increase interval by 5s
          interval += 5000;
          continue;

        case "expired_token":
          return { phase: "expired" };

        case "access_denied":
          return { phase: "denied" };

        default:
          return {
            phase: "error",
            error: errorData.error_description || `Unknown error: ${errorData.error}`,
          };
      }
    } catch (error) {
      // Network error — retry (don't fail immediately)
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Poll attempt ${attempts} failed: ${message}`);

      // After 3 consecutive network failures, give up
      if (attempts > 3) {
        return {
          phase: "error",
          error: `Network error during polling: ${message}`,
        };
      }
      continue;
    }
  }

  // Deadline reached
  return { phase: "expired" };
}

// ============================================
// Token Refresh
// ============================================

/**
 * Refresh an access token using a refresh token.
 *
 * @param refreshToken - The refresh token from the initial device flow
 * @param config - Auth config with Clerk endpoints
 * @returns New token response, or null on failure
 */
export async function refreshAccessToken(
  refreshToken: string,
  config: AuthConfig,
): Promise<DeviceTokenResponse | null> {
  try {
    const response = await fetch(config.deviceTokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: config.oauthClientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    if (!response.ok) return null;

    return (await response.json()) as DeviceTokenResponse;
  } catch {
    return null;
  }
}

// ============================================
// Utilities
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Format the device flow state for display in the CLI.
 *
 * @returns Human-readable status string
 */
export function formatDeviceFlowStatus(state: DeviceFlowState): string {
  switch (state.phase) {
    case "idle":
      return "Ready to authenticate";
    case "awaiting_user":
      return `Visit ${state.verificationUri} and enter code: ${state.userCode}`;
    case "polling":
      return `Waiting for approval (attempt ${state.attempts})...`;
    case "completed":
      return "Authentication successful";
    case "expired":
      return "Code expired. Please try again.";
    case "denied":
      return "Authentication denied by user.";
    case "error":
      return `Error: ${state.error}`;
  }
}
