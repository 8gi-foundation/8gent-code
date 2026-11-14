# Signed tool calls

Status: design only. Gap register 8gi-governance#1108, gap 7.
Depends on: gap 2 (hash-chained audit trail) and gap 3 (Linux isolation, `packages/permissions/bwrap.ts`).

## Problem

A tool call today is a JSON object the harness builds and then runs. Nothing records, in a way
a third party can check later, which vessel asked for it, under which policy, and that the
command that ran is the command that was approved. The audit store is append-only but a record
can be written by anything that can write the file.

## What a signature proves

One signed record per tool call proves three things:

1. **Who:** the call came from a named vessel (one install of 8gent on one machine).
2. **What:** the exact tool name and arguments, byte for byte, as approved.
3. **Under what:** the policy verdict and the sandbox it ran in (seatbelt, bwrap, none).

It does not prove the command was safe. That is the policy engine's and the sandbox's job.

## Keys

- **Algorithm:** ed25519. Built into Bun and Node (`crypto.sign(null, data, key)`), no
  dependency, 64-byte signatures, deterministic.
- **One key pair per vessel.** Made on first run, never copied between machines.
- **Where the private key lives:** `~/.8gent/keys/vessel-ed25519.pem`, mode 0600, in a 0700
  folder. `~/.8gent/keys` is already on the sandbox deny list (`sensitiveCredentialPaths()`),
  so no sandboxed command, on macOS or Linux, can read it. On hosts with a TPM or Secure
  Enclave a later slice can move it there; the file is the first slice.
- **Public key:** published as `vessel.pub` next to the audit store, and registered in the
  vessel registry (one line: vessel id, public key, created at, retired at).
- **Vessel id:** first 16 hex characters of SHA-256 of the raw public key.

## What is signed

The signing input is a canonical JSON object (keys sorted, no whitespace, UTF-8):

```json
{
  "v": 1,
  "vessel": "3f9a0c1e5b7d2a44",
  "seq": 1042,
  "prev": "<sha256 of the previous signed record>",
  "at": "2026-11-14T10:22:31.512Z",
  "session": "<session id>",
  "tool": "run_command",
  "args_sha256": "<sha256 of canonical args>",
  "verdict": "allow",
  "policy_sha256": "<sha256 of the loaded policy files>",
  "sandbox": "bwrap"
}
```

- Arguments are hashed, not embedded, so a record can be shared without leaking file
  contents or secrets. The full arguments stay in the local audit store.
- `seq` and `prev` make the signed records a chain (this is gap 2's hash chain; the signature
  is what makes the chain's head trustworthy).
- `sandbox` is the `isolation` field of `SandboxResult`. A call that ran with
  `unavailable` set is never signed as run.

## Where signing happens

In the tool executor, after the policy verdict and before the spawn. Order:

1. Policy engine decides.
2. Build the record, sign it, append it to the audit store.
3. Run the tool in the sandbox.
4. Append a second, signed result record (`exit`, `stdout_sha256`, `duration_ms`) pointing at
   the first by hash.

If signing fails (no key, unreadable key), the call is refused. Unattended means no.

## Verification

`8gent audit verify [--from seq]`:

- walks the chain, checks every `prev` hash and every signature against the vessel's public key;
- reports the first broken link with its seq number, exit 1;
- needs only the audit file and `vessel.pub`, so a reviewer can run it on another machine.

## Rotation and loss

- **Rotate:** make a new key pair; the last record signed by the old key is a `rotate` record
  carrying the new public key, signed by the old key. The registry gets `retired_at` for the old
  key. Verification follows the rotate records.
- **Schedule:** on demand and on every major version; no timer (local by default, nothing
  phones home).
- **Lost or leaked key:** mark it retired in the registry with the time of the incident.
  Records after that time signed by the old key are reported as untrusted, not deleted.

## Smallest first slice

One PR, `packages/audit` plus the executor hook, behind `EIGHT_SIGNED_TOOLS=1`, default off:

1. key creation and loading (0600 file, refuse on wrong mode);
2. canonical JSON + sign + append for `run_command` only;
3. `8gent audit verify` over that one tool;
4. tests: tamper one byte of a record, verify fails at that seq; delete a record, verify fails;
   missing key with the flag on, the call is refused.

No registry service, no TPM, no cross-vessel trust in the first slice.

## Depends on

- **Gap 2, hash chain:** `seq` and `prev` are that chain. Build gap 2 first, then this slice
  adds signatures to its records rather than inventing a second chain.
- **Gap 3, Linux isolation:** the key's protection inside a run is the sandbox deny list. On
  Linux that is bwrap; without it, any command the vessel runs on the box could read the key
  and sign whatever it likes. Signing on an unsandboxed Linux host is therefore refused.

## Not doing

No blockchain, no zk proofs, no remote signing service, no signing of model outputs.
