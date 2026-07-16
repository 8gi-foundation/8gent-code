# Code Signing for 8gent Code binaries

The cross-platform packaging pipeline (`scripts/build-binaries.ts`,
`scripts/package-linux.sh`, `scripts/package-windows.ps1`, and
`.github/workflows/release-binaries.yml`) produces self-contained per-OS
binaries and installers. Signing is **opt-in and skip-if-absent** everywhere:
with no credentials configured, the pipeline emits **unsigned but runnable**
artifacts. Unsigned artifacts run fine on the machine that built them but
trigger OS trust prompts (Gatekeeper, SmartScreen) on other machines.

Nothing in this repo contains a certificate, private key, or account
credential. This document lists exactly what a maintainer must procure and
which env var / secret wires it in. **A contributor cannot produce signed
installers** without these - only the maintainer holding the accounts can.

---

## macOS - Apple Developer ID

To ship a Mac binary that passes Gatekeeper without a right-click override you
need an **Apple Developer Program** membership (99 USD/year).

| What to procure | Where it goes |
| --- | --- |
| Developer ID Application certificate (in the login keychain of the build Mac) | `EIGHT_MAC_SIGN_IDENTITY` env / secret, e.g. `Developer ID Application: Your Name (TEAMID)` |
| App Store Connect API key (`.p8`) + Key ID + Issuer ID, for notarization | `AC_API_KEY_P8`, `AC_API_KEY_ID`, `AC_API_ISSUER` secrets |

- Codesigning happens in `build-binaries.ts` (`codesign --options runtime
  --timestamp`) when `EIGHT_MAC_SIGN_IDENTITY` is set.
- Notarization + stapling happens in the release workflow's "Notarize macOS
  binaries" step when `AC_API_KEY_ID` is present.
- Local dry run once you have a cert:
  `EIGHT_MAC_SIGN_IDENTITY="Developer ID Application: ..." bun run scripts/build-binaries.ts --only=bun-darwin-arm64`

## Windows - Authenticode

Windows SmartScreen distrusts unsigned executables. Two supported routes:

**Route A (recommended): Azure Trusted Signing** (~10 USD/month). No local cert
to guard; Microsoft holds the key. Procure an Azure subscription, a Trusted
Signing account + certificate profile, and a service principal.

| What to procure | Where it goes |
| --- | --- |
| Trusted Signing dlib + metadata json | `EIGHT_AZURE_DLIB`, `EIGHT_AZURE_METADATA` |
| Enable flag | `EIGHT_AZURE_SIGN=1` |
| Service principal creds | standard `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` consumed by the dlib |

**Route B: OV or EV Authenticode certificate** from a CA (DigiCert, Sectigo,
etc.). EV certs give instant SmartScreen reputation but require a hardware
token / cloud HSM. Export/reference a `.pfx`:

| What to procure | Where it goes |
| --- | --- |
| Authenticode code-signing cert as `.pfx` | `EIGHT_WIN_PFX` |
| Its password | `EIGHT_WIN_PFX_PASSWORD` |

`scripts/package-windows.ps1` signs both the raw `.exe` and the NSIS installer
via `signtool` (Azure route first, PFX second) when the vars are present.

## Linux - GPG (repository signing)

`.deb` and `.rpm` files are trusted via a **GPG key** whose public half users
add to their apt/dnf keyrings. No paid account - generate a key
(`gpg --full-generate-key`, RSA 4096) and publish the public key.

| What to procure | Where it goes |
| --- | --- |
| GPG signing key ID | `EIGHT_GPG_KEY_ID` |
| Exported private key file for the build runner | `EIGHT_GPG_KEY_FILE` |

`scripts/package-linux.sh` passes these to nfpm's native deb/rpm signing when
set. For a real apt/dnf repository (vs. loose files on a Release), publish the
public key at a stable URL and host the packages behind it; that is a follow-up
beyond this pipeline.

## winget

`packaging/winget/` holds a 3-file manifest template. Submission to
`microsoft/winget-pkgs` requires a **signed** Windows installer attached to a
public GitHub Release and the correct `InstallerSha256`. The release workflow
computes the sha on upload; the maintainer opens the winget PR (or wires
`wingetcreate`) once a signed installer exists.

---

## Summary: what is shippable today vs. what needs the maintainer

| Artifact | Buildable by anyone now | Needs maintainer credential to be **trusted** |
| --- | --- | --- |
| `8gent-<os>-<arch>` raw binaries | Yes (unsigned) | Apple Developer ID (mac), Authenticode (win) |
| `.deb` / `.rpm` / `.tar.gz` | Yes (unsigned) | GPG key for repo trust |
| Windows NSIS installer | Yes (unsigned) | Azure Trusted Signing or PFX |
| winget manifest submission | Template only | Signed installer on a public Release |

The **pipeline** is complete and validated. The **trust** on top of it is
gated on accounts only the maintainer can open.
