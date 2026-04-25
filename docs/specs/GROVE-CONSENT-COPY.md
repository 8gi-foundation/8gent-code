# Grove Consent Ceremony — Copy Draft

> Issue #1568 / parent #1559. Status: **COPY DRAFT** for review by 8DO (Moira) and 8PO (Samantha).

## Purpose

Before a user joins their first Grove pod, they pass a 3-screen consent flow. One decision per screen. Plain English. Default OFF. Signed acknowledgement stored locally.

This is the copy. Implementation lives in `apps/tui/src/consent/Grove.tsx` (Ink component, keyboard-first navigation, screen-reader compliant) and is a separate PR.

## Constraints carried forward

- No purple, pink, or violet (BRAND.md, hues 270-350 banned)
- No em-dashes anywhere in copy (use commas, colons, hyphens, or rewrite)
- Reading grade 9 or lower (verified with the Hemingway pass below)
- Each screen must work with VoiceOver and NVDA
- Each screen has exactly one decision: continue, decline, or back
- Default decision is "decline" / "exit"

## Tone

Direct. No marketing. No metaphors that obscure what is actually happening. The user has to be able to tell their friend, in one sentence, what they just agreed to.

---

## Screen 1: What you share

### Heading

**Joining a Grove**

### Subhead

You are about to share part of your machine with a small group of peers. Here is what that means in plain terms.

### Body

When you join, your machine becomes a peer in a pod. Other members of the pod can send you a request, and your machine will run that request and send back the answer.

To do this, three things from your machine are used:

- **A slice of your VRAM.** The model that runs the request needs to live in memory. You set how much you are willing to lend.
- **A slice of your CPU or GPU time.** Each request takes compute. The pod schedules requests in your idle hours by default. You can change this later.
- **The text of the request, in your machine's RAM, while it runs.** When a peer sends you a question, the text of that question is in your computer's working memory for the few seconds it takes to answer. It is never written to a file. It is never logged. When the answer is sent, the text is gone.

Your own files, your messages, your browser history, and your existing 8gent sessions are not touched. The pod only sees what other peers send into it.

You can leave a pod at any time. Leaving stops new requests immediately and does not delete anything from your machine.

### Decision

`[Continue]`  `[Cancel]`

Default focus is on `Cancel`. Pressing Esc cancels.

---

## Screen 2: What you receive

### Heading

**What you get back**

### Subhead

In return for sharing, you can use models bigger than your own machine could run alone.

### Body

When you ask your 8gent a question that needs more compute than your machine has, the request is sent to one of your pod peers. They run it, and you get the answer.

Two important boundaries in this version:

- **Your prompts only travel to peers in this pod.** Not to strangers, not to a marketplace, not to a public network. The pod is small and named. Members are listed on the next screen.
- **Verification is on by default.** When you receive an answer from a peer, your machine quietly checks that the answer is consistent with what other peers in the pod would say. If anything looks off, the request is retried elsewhere and the suspicious peer is reported.

What you do NOT get in this version:

- Access to closed commercial models you do not already have keys for. The pod can run open models on shared hardware. It cannot give you OpenAI or Anthropic without your own keys.
- Anonymity from your peers. The other members of the pod can see that you, by your vessel name, sent a request. They do not see your identity beyond that name. Pick a name you are comfortable with.

### Decision

`[Continue]`  `[Back]`

Pressing Esc returns to Screen 1.

---

## Screen 3: Confirm

### Heading

**Confirm and join**

### Subhead

Read this back. If anything is wrong, go back. If everything is right, sign and join.

### Body

You are joining the pod **{POD_NAME}**.

You are sharing:

- Up to **{VRAM_GB} GB** of VRAM
- Up to **{CPU_PERCENT}%** of one CPU core during idle hours
- The text of any request a peer sends you, in working memory only, for the time it takes to answer

You are receiving:

- Access to {SHARED_MODELS} via shared compute
- Verification on every result, by default

Your peers in this pod are:

```
{PEER_LIST_NAMES_AND_FINGERPRINTS}
```

You can leave at any time by running `8gent grove leave` or by clicking Leave Pod in the dashboard. Leaving takes effect immediately.

A signed record of this consent will be stored on your machine at:

```
~/.8gent/grove/consent-{TIMESTAMP}.json
```

This record stays on your machine. It is not uploaded.

### Decision

`[ ] I have read each screen and I want to join this pod.`

`[Sign and join]`  `[Back]`

The Sign button is disabled until the checkbox is checked. Default focus is on `Back`. Pressing Esc returns to Screen 2.

---

## Shared elements across all three screens

### Header strip

`Grove consent  ·  Step {N} of 3  ·  [Esc to exit]`

### Footer strip

`8gent · grove consent · v1`

The version number bumps when the copy changes in any material way. The signed ack records the version number, so an audit can answer "what exactly did this user see when they signed?"

## Plain-English check

Drafted for reading grade 9 or lower. Sentences kept short. Industry terms like *VRAM*, *peers*, *pod* are introduced in context. Where possible, the active voice and a concrete subject. Avoided: *leverage*, *empower*, *seamless*, *unlock*, *experience* (as a verb).

A formal Hemingway grade pass should be run before the component lands. If any sentence comes back at grade 11+, it gets rewritten before the copy is shipped to 8DO.

## Accessibility audit checklist

The component (separate PR) must pass:

- [ ] VoiceOver reads each heading, subhead, body, and decision. No "button" labels without accessible names.
- [ ] NVDA same.
- [ ] Tab order is: heading → body → primary action → secondary action.
- [ ] Esc from any screen returns to the previous screen, or exits from screen 1.
- [ ] Screen 3 checkbox is reachable by Tab, toggleable by Space.
- [ ] No colour-only signalling — focus rings have a visible outline change, not just a colour swap.
- [ ] No purple/pink/violet anywhere in the rendered styles. Earth palette + amber accents only (per BRAND.md).
- [ ] No em-dashes in any rendered string.

## Signed acknowledgement schema

```json
{
  "version": "v1",
  "timestamp": "2026-04-25T15:00:00.000Z",
  "podName": "neuro-uk-1",
  "userVesselId": "user-vessel-abc123",
  "scope": {
    "vramGb": 8,
    "cpuPercent": 25,
    "hoursIdleOnly": true
  },
  "peers": [
    { "name": "grove-peer-a", "fingerprint": "ed25519:..." },
    { "name": "grove-peer-b", "fingerprint": "ed25519:..." }
  ],
  "sharedModels": ["qwen3:14b", "nemotron-3-super-120b-a12b:free"],
  "verificationMode": "tier1-spotcheck",
  "signature": "ed25519:..."
}
```

The signature is from the user's local key (the same key used by the daemon for vessel identity). No remote signing. No server-side acknowledgement.

## Open questions for review

1. Screen 3 lists peers by name + fingerprint. If a pod has 20+ peers, should the list scroll or paginate? Proposing: scrollable list with ten visible at a time.
2. Should the consent ceremony also gate `--grove-byzantine-defense=off`? Probably yes — anyone turning verification off should re-pass the ceremony with that explicit warning. (This is a v1 item, not blocking.)
3. Do we want a "remind me what I agreed to" command? Proposing: `8gent grove status` reads the most recent consent file and pretty-prints it.

## References

- Constitution: Lotus-Class Compute (Article 11)
- Parent: #1559
- BRAND.md (no purple/pink/violet, earth palette)
- Memory: feedback_no_em_dashes (em-dashes banned in 8GI publications)
- Spec for the byzantine defence the consent screen describes: `docs/specs/GROVE-BYZANTINE-DEFENSE.md`
