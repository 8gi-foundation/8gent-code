# Browser secrets file on Windows (accepted risk, #3814)

`{{secret:NAME}}` placeholders in browser steps read a JSON secrets file
(`EIGHT_BROWSER_SECRETS_FILE`). On macOS and Linux the file must be mode 0600:
a group- or world-readable file is refused.

Windows has no POSIX mode bits (`stat` reports 0o666 for every file), so the
mode check cannot run there. What applies instead:

- The file must be inside the user's home folder (compared after resolving
  8.3 short names and case-insensitively). A path elsewhere, such as
  `C:\ProgramData` or a share, is refused.
- The home folder's NTFS ACL is user-only by default, and the file inherits it.

Accepted risk: the ACL itself is not read. A user who loosens the ACL on their
own home folder, or adds an explicit grant to the file, is not caught. Threat
model: the secrets file is created by the owner on their own machine; the model
never sees the value and the page receives it only for hosts listed in the file.

Code: `secretsPathInHome` and `resolveSecretText` in `packages/tools/eight-browser.ts`.
Tests: `packages/tools/__tests__/eight-browser.test.ts` (the rule runs on any OS).
