# Signing the 8gent Model Proxy

Honest status: this repo produces **unsigned** binaries and installers. Signing
is wired into `release-proxy.yml` as **opt-in** and skips cleanly when the
secrets below are absent. No certificate is bundled, faked, or generated. To
ship signed, notarized artifacts a maintainer must procure the credentials
listed here and add them as repository secrets.

Nothing in the codebase is blocked on this - unsigned binaries run fine for
developers. Signing is what stops the OS from warning end users, and is required
for smooth installs at scale.

## macOS - Developer ID + notarization

**What to procure**

- An Apple Developer Program membership (99 USD/year) for the 8GI Foundation.
- A **Developer ID Application** certificate (created in the Apple Developer
  portal, exported from Keychain as a password-protected `.p12`).
- An App Store Connect API key (Issuer ID + Key ID + `.p8`) or an
  app-specific password, stored as a `notarytool` keychain profile.

**Secrets to set**

| Secret                                    | Contents                                            |
| ----------------------------------------- | --------------------------------------------------- |
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64`      | base64 of the exported `.p12`                       |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD`        | password used when exporting the `.p12`             |
| `APPLE_TEAM_ID`                           | 10-char Apple Team ID (also the cert common name)   |
| `APPLE_NOTARY_KEYCHAIN_PROFILE`           | name of the stored `notarytool` credential profile  |

When present, the macOS job codesigns each darwin binary with the hardened
runtime and submits it to Apple's notary service. When absent, it emits a build
warning and ships unsigned.

## Windows - Authenticode

**What to procure**

- An **Authenticode code-signing certificate** from a trusted CA (DigiCert,
  Sectigo, etc.). A standard OV cert works; an **EV** cert additionally clears
  Microsoft SmartScreen reputation immediately (recommended, ~sold on HSM/USB
  token or cloud-HSM - budget for the token/HSM flow if EV).
- Export it as a password-protected `.pfx` (OV) or wire the CI to the CA's
  cloud-HSM signing tool (EV).

**Secrets to set**

| Secret                             | Contents                          |
| ---------------------------------- | --------------------------------- |
| `WINDOWS_AUTHENTICODE_PFX_BASE64`  | base64 of the `.pfx`              |
| `WINDOWS_AUTHENTICODE_PASSWORD`    | password for the `.pfx`           |

When present, the Windows job signs both the proxy binary and the NSIS
installer with `signtool` + an RFC-3161 timestamp. When absent, it warns and
ships unsigned.

> EV certs on a hardware token cannot be base64'd into a secret. For EV, replace
> the `signtool /f` invocation with the CA's cloud-HSM signing plugin
> (DigiCert KeyLocker, Azure Trusted Signing, etc.) and store that tool's
> credentials as secrets instead.

## Linux - package integrity

`.deb` / `.rpm` are not code-signed the way macOS/Windows binaries are. Trust on
Linux comes from the **repository** signature:

- Generate a GPG key for the 8GI Foundation.
- Sign the APT `Release` file (`apt-ftparchive` / `reprepro`) and the RPM repo
  metadata (`rpm --addsign`, `createrepo_c` + GPG).
- Publish the public key so users can `apt-key` / import it.

This is a distribution concern (hosting an APT/YUM repo), separate from the
build, so it is intentionally not in `release-proxy.yml`. Add it when a package
repo is stood up.

## Summary of what James must obtain

1. Apple Developer Program membership + Developer ID Application cert +
   notarization credential.
2. A Windows Authenticode cert (EV recommended for SmartScreen).
3. A GPG key + a hosted APT/YUM repo, only if Linux packages are distributed via
   a repo rather than direct download.

Until (1) and (2) exist, the pipeline ships **unsigned** artifacts, and CI stays
**gated on GitHub Actions billing** regardless.
