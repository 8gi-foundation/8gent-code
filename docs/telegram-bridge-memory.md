# Telegram bridge memory (Phase 1)

Epic: 8gi-foundation/8gent-code#4391. Code: `packages/memory/telegram-memory*.ts`, `packages/memory/purge.ts`, wiring in `packages/daemon/telegram-bridge.ts`.

## Scope

Phase 1 remembers the operator's own typed turns in a one-to-one DM, and nothing else. No other people, no groups, no graph, no voice notes. It is inert unless the operator's DM is listed in `TELEGRAM_MEMORY_CHAT_IDS` (default empty): with the default the bridge creates no directory, no key and no file.

What is stored: the text of each turn, after control characters and invisible Unicode are stripped, secrets are redacted and the row is capped at 2 KB. What is recalled: up to 5 earlier rows from the same user in the same chat, quoted as untrusted data in the prompt prefix.

Messages still travel through Telegram. Nothing here changes that, and nothing in this feature should be described as keeping the Telegram path hidden or local.

## Residual risks (read before enabling)

1. **Plaintext session history.** Encryption covers the vault copy (`memory.db.enc`) only. The existing `telegram-sessions.json` still holds the operator's last 40 turns in plaintext whenever session persistence is on, and Phase 1 does not change that. `/memwipe` clears that history for the chat, but while it exists it is a second, unencrypted copy.
2. **Recalled text in runtime transcripts.** The recalled block is sent to the model as part of the prompt. The daemon and model runtime may persist that prompt in their own session transcripts. Those copies are not encrypted and `/memwipe` does not reach them. Everything recalled is the operator's own earlier text, so there is no new exposure to a third party in Phase 1.
3. **Keychain key in argv.** On first use the key is created with `security add-generic-password -w <hex>`, so for a few milliseconds it is visible in that process's arguments to same-user processes. Tracked: pass it on stdin via `security -i`.
4. **What the key protects.** The key lives in the macOS login Keychain. A key created by the `security` CLI can be read by other processes running as the same user (`security find-generic-password -w`). So the encryption defends against theft of the file or a backup taken without the login keychain. It does not defend against malware running as the operator.
5. **Backups.** There is no Time Machine exclusion yet. A backup of `memory.db.enc` taken before a wipe stays decryptable with the same key, so a wipe does not reach earlier backups. Tracked: `tmutil addexclusion`. Until then, exclude `~/.8gent/memory` by hand if backups matter.
6. **Matrix rule.** A malformed edit to `matrix.json` after a good load keeps serving the last good copy and writes an audit row. A missing file, or a malformed first load, is closed (nothing stored or recalled). An empty `rows` list is valid and means deny all, so emptying the file revokes. A same-size edit inside one filesystem timestamp tick can be missed (the file signature is mtime and size).
7. **Lost key.** If the Keychain item is lost, the vault cannot open, and `/memwipe` reports that. To recover, delete `memory.db.enc` by hand (the data is unreadable without the key anyway) and start again. There is no automated recovery.
8. **Audit failure is fail-open.** If the audit log cannot be written, the action still proceeds and a count-only line is logged. Tracked.
9. **Not covered by a wipe:** Telegram's own servers, other transcripts, backups made earlier.
10. **Legacy path.** With `EIGHT_TG_LEGACY=1` recall runs but its text is not used.

## Enabling runbook

Do this only after a live run has been recorded (Keychain create-then-read under launchd, DM store and recall, `/memwipe` two-step with counts, audit verify OK, `strings` on `memory.db.enc` finding no test phrase).

1. Confirm the operator list: `TELEGRAM_OPERATOR_USER_IDS` must name the operator explicitly. There is no fallback to the first authorised user.
2. Seed the matrix (operators only, refuses to overwrite):
   `TELEGRAM_OPERATOR_USER_IDS=<id> bun packages/memory/telegram-memory.ts seed-matrix [dir]`
   The default directory is `$EIGHT_DATA_DIR/memory`, else `~/.8gent/memory`. The file is `matrix.json`, mode 0600:
   `{"version":1,"rows":[{"userId":"<id>","chat":"dm","caps":["memory_write","memory_recall"]}]}`
3. Set `TELEGRAM_MEMORY_CHAT_IDS=<operator DM chat id>` in the bot environment and restart the bot through its normal service command. The DM chat id equals the operator's user id.
4. Send a DM, then a follow-up that overlaps it, and check the follow-up was recalled.

## Controls

- Kill switch: `TELEGRAM_MEMORY_DISABLED=1` in the environment, or `/memoff` in the operator DM. Either stops all reads and writes on the next message, no restart, data left in place. `/memon` reverses `/memoff` only; the environment variable wins.
- Erase: `/memwipe` answers with a 6-digit code; send `/memwipe <code>` within 2 minutes (3 tries). It deletes every memory table, re-seals the vault, vacuums, checks every count is zero, and clears that chat's session history. The reply lists counts only.
- These commands work only for the operator in a DM, need no matrix row (so they work when the matrix is broken), and create nothing when memory was never enabled.
- Verify the audit chain: `bun packages/memory/telegram-memory-audit.ts verify [path]` (default `~/.8gent/memory/audit.jsonl`). Exit 0 and `OK <n> line(s)` means intact; exit 1 names the first broken line. The log holds ids, codes and counts, never message text, and a wipe does not touch it.

## Files (all under the memory directory, dir 0700, files 0600)

`memory.db.enc` (sealed store), `matrix.json`, `audit.jsonl`, `audit.salt`, `disabled` (present when `/memoff` is active).
