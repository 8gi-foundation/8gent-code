# 8GI Onboarding - ARTALE (R Tale)

**Date:** 26 March 2026
**Vouched by:** James Spalding (Founder, CAO)
**Status:** First circle member beyond the founder
**Discord:** ARTALE (R Tale)

---

## Welcome Message (for James to send on Discord)

Copy and send this on Discord:

---

Hey ARTALE - welcome to 8GI.

8GI (Infinite General Intelligence) is an ethical collective intelligence. Trusted humans and their AI agents working together as a hive mind. Each member gets their own AI vessel - a persistent agent that runs 24/7, learns from your patterns, and contributes to the collective. It is not a Discord server or a Slack group. It is an engineering collective with real infrastructure, real code, and real accountability.

Before anything else, read the Constitution: https://8gent.world/constitution

It has 10 articles. They cover ethics, privacy, open source, security, and how we work together. If you agree to all 10, we move forward. If any of them feel wrong to you, say so - we can talk about it, but agreement is non-negotiable for membership.

Here is what you get as a member:
- A local AI coding agent (8gent Code) running on your machine with local models - no API keys required to start
- Your own Telegram bot - your personal AI companion that lives in the group
- A persistent vessel deployed on Fly.io - your agent runs even when your laptop is off
- Citizenship in the 8gent Games world (AI civilisation simulator, Dublin is the first city)
- Access to the full codebase, ability pool, and shared memory layer

Here is what you give:
- Pull requests. Code review. Bug reports. Honest feedback.
- Anonymised usage patterns that help the collective learn (nothing personal leaves your machine without your explicit opt-in)
- Your time and attention when the circle needs it

This is member number two. I built the foundation. You are the first person I trust to build on it with me.

James Spalding vouches for you.

Let me know when you have read the Constitution and we will get you set up.

---

## Manual Onboarding Checklist

Since the automated onboarding pipeline is not built yet, James does each step manually.

### Pre-setup

- [ ] **1. Send welcome message on Discord** - copy the message above
- [ ] **2. ARTALE confirms Constitution agreement** - they must explicitly confirm they have read and agree to all 10 articles. Screenshot or written confirmation in Discord/Telegram. Do not proceed without this.

### Access provisioning

- [ ] **3. Add ARTALE to PodJamz GitHub org** - go to https://github.com/orgs/PodJamz/people and invite their GitHub account. Give them "Member" role (not admin). Confirm their GitHub account is not a throwaway - check account age and activity.
- [ ] **4. Add ARTALE to 8GI Telegram group** - send them the invite link. They need Telegram installed first.

### Local setup

- [ ] **5. Send setup script**
  ```
  git clone https://github.com/PodJamz/8gi-setup && cd 8gi-setup && ./setup.sh
  ```
  Walk them through any failures. Document every issue for automation later.

### Telegram bot creation

- [ ] **6. Help them create a Telegram bot via @BotFather**
  - Open Telegram, search for @BotFather
  - Send `/newbot`
  - Bot name: `ARTALE 8gent` (or their preference)
  - Bot username: `@8gent_artale_bot` (or similar available name)
  - Copy the bot token - they will need it for the next step
  - Do NOT share the bot token in any public channel

### Vessel deployment

- [ ] **7. Deploy their vessel on Fly.io**
  ```bash
  fly apps create 8gi-artale-vessel --org podjamz
  fly secrets set TELEGRAM_BOT_TOKEN=their_token --app 8gi-artale-vessel
  fly deploy --app 8gi-artale-vessel
  ```
  Verify the app is running: `fly status --app 8gi-artale-vessel`

### Integration

- [ ] **8. Add their bot to the Telegram group** - use the bot username to add it to the 8GI group chat
- [ ] **9. Verify everything works**
  - Vessel responds to messages in the group
  - Factory sync works (vessel picks up jobs from the pipeline)
  - Companion spawns and responds to direct messages
  - Check vessel logs: `fly logs --app 8gi-artale-vessel`
- [ ] **10. Document friction** - write down every step that failed, confused them, or took longer than expected. This becomes the spec for automating onboarding.

---

## Security Checklist (Karen's Requirements)

Karen (CSO vessel) requires the following before a member is fully active:

- [ ] ARTALE has read all 10 Constitution articles
- [ ] ARTALE has confirmed agreement (screenshot or signed message saved)
- [ ] GitHub account verified (not a throwaway - check account age, repos, activity)
- [ ] NemoClaw policies deployed on their machine (installed via setup.sh, deny-by-default)
- [ ] Vessel deployed with strict policy - not configurable by the member
- [ ] Bot token stored in Fly secrets only - not in any repo, not in any chat, not in plaintext anywhere
- [ ] Audit logging enabled on their vessel (all tool calls, all file operations logged)
- [ ] First PR goes through quarantine branch (not direct to main)
- [ ] No admin access to GitHub org until Core membership criteria met (6 months, 10 merged PRs)
- [ ] ARTALE's local machine runs NemoClaw security gate on all LLM-generated code before commit

---

## What to Track (for improving the flow)

Record these metrics during onboarding to build the automation spec:

| Metric | Value |
|--------|-------|
| **Time from welcome message to Constitution confirmation** | |
| **Time from confirmation to GitHub access** | |
| **Time from GitHub access to local setup complete** | |
| **Time from setup complete to vessel online** | |
| **Total time: welcome to vessel online** | |
| **Steps that failed** | |
| **Steps that confused them** | |
| **Questions they asked** | |
| **Suggestions they made** | |
| **Overall friction score (1-10)** | |

### Notes

Use this section to capture anything that came up during onboarding that does not fit the table above. Every pain point here becomes a ticket for the automated onboarding pipeline.

---

## Post-Onboarding

Once ARTALE is fully onboarded:

1. They should submit their first PR (any size, any package) through the quarantine branch
2. James reviews and merges - this is their "first commit" ceremony
3. Their vessel joins the factory rotation for nightly research jobs
4. They start as a **Contributor** (per the Governance Charter, Section 1.3)
5. Core membership is possible after 6 months and 10 merged PRs

---

*This document is specific to ARTALE's onboarding. Lessons learned here will be folded back into the general [8GI-ONBOARDING.md](8GI-ONBOARDING.md) guide and used to build the automated pipeline.*
