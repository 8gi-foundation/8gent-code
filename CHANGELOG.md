# Changelog

All notable changes to 8gent Code will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.20.16] - 2026-10-22

### Fixed
- "run pi" opens the pi tab through /term, no model tokens (#4764) ([#4765](https://github.com/8gi-foundation/8gent-code/pull/4765))
- a greeting alone gets no tools, and a plain home folder is not a project ([#4760](https://github.com/8gi-foundation/8gent-code/pull/4760))
- decide: allow --version and -v probes for any bare binary name ([#4757](https://github.com/8gi-foundation/8gent-code/pull/4757))
- an empty end after refused calls names what was refused and why ([#4759](https://github.com/8gi-foundation/8gent-code/pull/4759))
- tui: a running turn's calls never read No reply. (#4756) ([#4758](https://github.com/8gi-foundation/8gent-code/pull/4758))

## [0.20.15] - 2026-10-22

### Added
- term: read_terminal and list_terminals for terminal tabs ([#4752](https://github.com/8gi-foundation/8gent-code/pull/4752))

### Fixed
- term: gate write_terminal like term_send, ask on first send per tab ([#4751](https://github.com/8gi-foundation/8gent-code/pull/4751))
- term: window mode only on darwin, in-tab on Linux and Android ([#4750](https://github.com/8gi-foundation/8gent-code/pull/4750))

## [0.20.14] - 2026-10-22

### Changed
- Android Termux and proot install path, Node version commands, signal exit ([#4747](https://github.com/8gi-foundation/8gent-code/pull/4747))

### Fixed
- tui: built-in slash commands run before the skill scan loads and after it fails ([#4745](https://github.com/8gi-foundation/8gent-code/pull/4745))

## [0.20.13] - 2026-10-22

### Fixed
- tui: the prompt stays live in every view unless a picker owns the keyboard, and Esc always returns (0.20.12 regression) ([#4740](https://github.com/8gi-foundation/8gent-code/pull/4740))

## [0.20.12] - 2026-10-22

### Added
- eight: required-output gate, the turn may not end while a named output file is missing (#4734) ([#4736](https://github.com/8gi-foundation/8gent-code/pull/4736))

### Fixed
- tui: number shortcuts that work in Termux, help shows only keys the terminal can send (#4723) ([#4738](https://github.com/8gi-foundation/8gent-code/pull/4738))
- eight: a stalled turn says it is waiting and gives up after a bound (#4727) ([#4737](https://github.com/8gi-foundation/8gent-code/pull/4737))
- permissions: a path the person names in the ask is readable; boundary blocks are terminal ([#4722](https://github.com/8gi-foundation/8gent-code/pull/4722))
- provider: one keyed provider and no local runtime means no question, and the choice persists (#4720) ([#4728](https://github.com/8gi-foundation/8gent-code/pull/4728))
- eight: no unprompted audio, COMPLETED line is a fixed form ([#4718](https://github.com/8gi-foundation/8gent-code/pull/4718))

## [0.20.11] - 2026-10-22

### Added
- voice: Android uses the keyboard mic; termux-tts-speak output; Termux hints ([#4726](https://github.com/8gi-foundation/8gent-code/pull/4726))
- memory: ME profile folder behind EIGHT_ME=1, /me and 8gent me import ([#4709](https://github.com/8gi-foundation/8gent-code/pull/4709))

### Fixed
- state: keep project memory and scratch out of the repo (#4711) ([#4719](https://github.com/8gi-foundation/8gent-code/pull/4719))
- goal: no private paths, safeSpawn, ready check before turn 1 (#4721) ([#4725](https://github.com/8gi-foundation/8gent-code/pull/4725))
- a proxy 403 is not a bad key; done gate sees `bun test`; ignored providers print once ([#4717](https://github.com/8gi-foundation/8gent-code/pull/4717))
- first-run: ask for the key in the app, name `8gent keys set`, bare / opens help ([#4704](https://github.com/8gi-foundation/8gent-code/pull/4704))
- release: publish the npm tarball by absolute path, fail loudly, add npm_only_tag repair (#4700) ([#4702](https://github.com/8gi-foundation/8gent-code/pull/4702))
- update: find the release without api.github.com and install the verified package with --ignore-scripts (#4698) ([#4701](https://github.com/8gi-foundation/8gent-code/pull/4701))
- install: fall back to the releases page when the GitHub API rate limits ([#4696](https://github.com/8gi-foundation/8gent-code/pull/4696))
- install: Termux npm path installs with --ignore-scripts (#4693) ([#4694](https://github.com/8gi-foundation/8gent-code/pull/4694))

## [0.20.10] - 2026-10-21

### Fixed
- release: run the Termux smoke under termux-exec LD_PRELOAD like a real shell (#4690) ([#4691](https://github.com/8gi-foundation/8gent-code/pull/4691))
- install: Termux installs the release npm package instead of refusing ([#4686](https://github.com/8gi-foundation/8gent-code/pull/4686))

## [0.20.9] - 2026-10-21

### Added
- /bug and 8gent bug write a secret-free local bug report folder ([#4657](https://github.com/8gi-foundation/8gent-code/pull/4657))

### Changed
- release smoke on a Termux arm64 userland and the Windows TUI, on the tag (#4666) ([#4672](https://github.com/8gi-foundation/8gent-code/pull/4672))

### Fixed
- the TUI never runs itself to find local models; /provider picks a hosted model (#4682) ([#4683](https://github.com/8gi-foundation/8gent-code/pull/4683))
- say why no model was chosen; 8gent keys set; no topK to OpenAI-compatible providers ([#4681](https://github.com/8gi-foundation/8gent-code/pull/4681))
- tui: NO MODEL once, onboarding question whole on phone-sized terminals ([#4677](https://github.com/8gi-foundation/8gent-code/pull/4677))
- tui: drop pre-intro banner and stale usage-cap claims, keep Lil Eight opt-in ([#4670](https://github.com/8gi-foundation/8gent-code/pull/4670))
- the standalone binary starts its own TUI, with no cache file or build paths ([#4675](https://github.com/8gi-foundation/8gent-code/pull/4675))
- Node TUI crash on first coloured text in Termux (chalk vs ansi-styles 6) ([#4661](https://github.com/8gi-foundation/8gent-code/pull/4661))
- npm i -g installs on Termux (remove miniflare, bundled deps to devDependencies) ([#4664](https://github.com/8gi-foundation/8gent-code/pull/4664))

## [0.20.8] - 2026-10-21

### Added
- run 8gent on plain Node 22.5+ with no Bun installed ([#4652](https://github.com/8gi-foundation/8gent-code/pull/4652))
- tools: in-process file search, no shell spawn (#4633) ([#4634](https://github.com/8gi-foundation/8gent-code/pull/4634))

## [0.20.7] - 2026-10-21

### Added
- masked /consult, one stateless cloud question with secrets and personal data masked ([#4619](https://github.com/8gi-foundation/8gent-code/pull/4619))

### Fixed
- voice: /voice chat uses the shared whisper model resolver and reports failures ([#4628](https://github.com/8gi-foundation/8gent-code/pull/4628))
- one registry-driven provider key resolver for every path (#4622) ([#4623](https://github.com/8gi-foundation/8gent-code/pull/4623))

## [0.20.6] - 2026-10-21

### Added
- sovereign meter, local-first policy, /route, /privacy and the locality ledger ([#4614](https://github.com/8gi-foundation/8gent-code/pull/4614))
- tui: /telegram setup guides a new user to post to their own chat ([#4595](https://github.com/8gi-foundation/8gent-code/pull/4595))
- local-model-server: model ledger pins the local model and warns when it changes (#4609) ([#4616](https://github.com/8gi-foundation/8gent-code/pull/4616))
- tools: EIGHT_SEARCH_URL for a self-hosted search endpoint (#4613) ([#4615](https://github.com/8gi-foundation/8gent-code/pull/4615))
- tui: drag to select and copy text, clicks keep working ([#4603](https://github.com/8gi-foundation/8gent-code/pull/4603))

## [0.20.5] - 2026-10-20

### Changed
- Never swap a cloud provider's model for a local one silently ([#4592](https://github.com/8gi-foundation/8gent-code/pull/4592))
- tui: hostile-terminal sends one Enter and waits for the screen to move (#4600) ([#4601](https://github.com/8gi-foundation/8gent-code/pull/4601))
- block new hardcoded model names (allow-list guard) ([#4583](https://github.com/8gi-foundation/8gent-code/pull/4583))

### Fixed
- tui: draw the active non-chat tab's body (Settings, Notes, ...) ([#4597](https://github.com/8gi-foundation/8gent-code/pull/4597))
- tui: provider picker from the registry, no cross-provider model, true missing-key and fetch-failure notices (#4598) ([#4599](https://github.com/8gi-foundation/8gent-code/pull/4599))
- tui: take typing after a probe reply that arrives at once (Refs #4540) ([#4589](https://github.com/8gi-foundation/8gent-code/pull/4589))

## [0.20.4] - 2026-10-20

### Changed
- verify attestation without --source-ref so older gh can install ([#4579](https://github.com/8gi-foundation/8gent-code/pull/4579))
- fail CI if the installed package contains Python or Swift (#4567) ([#4571](https://github.com/8gi-foundation/8gent-code/pull/4571))

### Fixed
- tui: quiet git probes outside a repo; resolve --provider model from the live list ([#4584](https://github.com/8gi-foundation/8gent-code/pull/4584))
- tui: 0x0 terminal size no longer blanks the first screen ([#4576](https://github.com/8gi-foundation/8gent-code/pull/4576))
- cli: one-shot always answers or names why it cannot ([#4573](https://github.com/8gi-foundation/8gent-code/pull/4573))

## [0.20.3] - 2026-10-20

### Added
- providers: declare MiniMax as a built-in provider ([#4568](https://github.com/8gi-foundation/8gent-code/pull/4568))
- daemon: advertise input-gate capability on session frames and /health ([#4546](https://github.com/8gi-foundation/8gent-code/pull/4546))
- tui: boot trace to ~/.8gent/logs/tui-boot.log, shown by 8gent doctor (Refs #4540) ([#4541](https://github.com/8gi-foundation/8gent-code/pull/4541))
- eight: friction record per session, written at session end, no UI (#4511) ([#4523](https://github.com/8gi-foundation/8gent-code/pull/4523))
- eight: step_finish records prompt and completion tokens from provider usage (#4520) ([#4521](https://github.com/8gi-foundation/8gent-code/pull/4521))
- permissions: three-tree spelling grid as a script and CI check (#4509) ([#4513](https://github.com/8gi-foundation/8gent-code/pull/4513))
- tui: status bar shows unverified and tests-claimed-not-run after a gated turn (#4510) ([#4515](https://github.com/8gi-foundation/8gent-code/pull/4515))
- eight: done gate refuses a tests-pass claim without a newer passing test run (#4505) ([#4507](https://github.com/8gi-foundation/8gent-code/pull/4507))
- eight: wire cache-aware failover affinity into the turn loop behind the flag (#4500) ([#4506](https://github.com/8gi-foundation/8gent-code/pull/4506))
- providers: cache-aware failover affinity behind a flag (#4500) ([#4503](https://github.com/8gi-foundation/8gent-code/pull/4503))
- keys: key vault with masked Keys screen in Settings, per-user (#3848) ([#3852](https://github.com/8gi-foundation/8gent-code/pull/3852))
- permissions: log every System One judge verdict (Refs #3885) ([#3886](https://github.com/8gi-foundation/8gent-code/pull/3886))

### Changed
- drop stale inline version from README install line ([#4564](https://github.com/8gi-foundation/8gent-code/pull/4564))
- run_command: say when a missing python module is on PATH as a binary ([#4559](https://github.com/8gi-foundation/8gent-code/pull/4559))
- first-moment splash status line, Windows early-raw skip and watchdog (Refs #4540) ([#4552](https://github.com/8gi-foundation/8gent-code/pull/4552))
- boot trace and what to paste when the TUI does not start (Refs #4540) ([#4550](https://github.com/8gi-foundation/8gent-code/pull/4550))
- input gate, unknown slash lines, Telegram classification, write_file loop breaker, heredoc refusal (#4531 #4532 #4534 #4535 #4536 #4538) ([#4543](https://github.com/8gi-foundation/8gent-code/pull/4543))
- every channel's input passes a deterministic gate before the model (slash registry first) ([#4531](https://github.com/8gi-foundation/8gent-code/pull/4531))

### Fixed
- daemon: fs.exec runs the shell sanitizer and wipe guard before spawn ([#4547](https://github.com/8gi-foundation/8gent-code/pull/4547))
- gate: rpc-server and telegram paths pass the input gate ([#4542](https://github.com/8gi-foundation/8gent-code/pull/4542))
- install: detect Android/Termux, clear early message, --dry-run and debug echo ([#4551](https://github.com/8gi-foundation/8gent-code/pull/4551))
- tui: the first moment is never blank or frozen ([#4544](https://github.com/8gi-foundation/8gent-code/pull/4544))
- eight: break write_file rewrite loops within a turn ([#4538](https://github.com/8gi-foundation/8gent-code/pull/4538))
- tui: an unknown slash line is answered locally and never reaches the model ([#4536](https://github.com/8gi-foundation/8gent-code/pull/4536))
- daemon: the Telegram bridge classifies typed and spoken input before the model ([#4535](https://github.com/8gi-foundation/8gent-code/pull/4535))
- daemon: bind loopback by default and require a token off loopback ([#4532](https://github.com/8gi-foundation/8gent-code/pull/4532))
- permissions: heredoc write refusals lead with the write_file remedy ([#4534](https://github.com/8gi-foundation/8gent-code/pull/4534))
- tools: run_command says one command per call in its first sentence ([#4527](https://github.com/8gi-foundation/8gent-code/pull/4527))
- permissions: read variables, arrays, aliases, functions and substitutions before the wipe check, family 5 of #4514 ([#4528](https://github.com/8gi-foundation/8gent-code/pull/4528))
- permissions: judge delegated command strings, family 4 of #4514 ([#4526](https://github.com/8gi-foundation/8gent-code/pull/4526))
- permissions: expand bracket globs before the wipe check, family 3 of #4514 ([#4525](https://github.com/8gi-foundation/8gent-code/pull/4525))
- permissions: expand braces and IFS before the wipe check, family 2 of #4514 ([#4524](https://github.com/8gi-foundation/8gent-code/pull/4524))
- permissions: decode ANSI-C escapes before the wipe check, first family of #4514 ([#4522](https://github.com/8gi-foundation/8gent-code/pull/4522))
- eight: write_file records the directories it creates so the session can remove its own scratch dir (#4516) ([#4517](https://github.com/8gi-foundation/8gent-code/pull/4517))
- permissions: split the text before a glued here-string in the blind pass (#4501) ([#4504](https://github.com/8gi-foundation/8gent-code/pull/4504))
- permissions: home directory wipes are always-blocked and chained lines are judged per segment (#4485) ([#4493](https://github.com/8gi-foundation/8gent-code/pull/4493))
- permissions: drop os.tmpdir() from default allowed prefixes, realpath prefixes (#4488) ([#4491](https://github.com/8gi-foundation/8gent-code/pull/4491))
- eight: term_spawn and term_send go through the command policy ([#3774](https://github.com/8gi-foundation/8gent-code/pull/3774))
- tools: native run_command policy gate and notebook writes confined (#3760) ([#3797](https://github.com/8gi-foundation/8gent-code/pull/3797))
- permissions: command policy covers more network tools and send forms ([#3806](https://github.com/8gi-foundation/8gent-code/pull/3806))
- memory: quote FTS5 terms and keep Unicode letters in recall queries ([#3539](https://github.com/8gi-foundation/8gent-code/pull/3539))
- onboarding: no key means Enter decides later, and the chat names what is missing (#4218) ([#4225](https://github.com/8gi-foundation/8gent-code/pull/4225))
- tui: one deterministic readiness answer drives the header and the NO MODEL card (#3290) ([#3297](https://github.com/8gi-foundation/8gent-code/pull/3297))

## [0.20.2] - 2026-10-19

### Added
- tools: run_batch action chunks behind EIGHT_RUN_BATCH (#3502) ([#4466](https://github.com/8gi-foundation/8gent-code/pull/4466))

### Fixed
- install: retry the release-list fetch and use GITHUB_TOKEN when present (#4468) ([#4472](https://github.com/8gi-foundation/8gent-code/pull/4472))
- release: pin makensis to the current Homebrew version and let a dispatch rebuild an existing tag (#4468) ([#4471](https://github.com/8gi-foundation/8gent-code/pull/4471))

## [0.20.1] - 2026-10-19

### Added
- ai: per-model harness profile for step budget, nudge point and output cap (#4439) ([#4445](https://github.com/8gi-foundation/8gent-code/pull/4445))
- tui: opt-in system theme that follows the terminal palette and light/dark (#4440) ([#4441](https://github.com/8gi-foundation/8gent-code/pull/4441))
- ai: nudge the model to write its best answer near the turn budget ([#4419](https://github.com/8gi-foundation/8gent-code/pull/4419))
- bridge: operator memory phase 1, encrypted local store with true purge ([#4394](https://github.com/8gi-foundation/8gent-code/pull/4394))
- bridge: relevant spoken voice ack ([#4388](https://github.com/8gi-foundation/8gent-code/pull/4388))
- bridge: operator voice in one allowlisted group, plus instant voice ack ([#4386](https://github.com/8gi-foundation/8gent-code/pull/4386))
- bridge: voice note in, spoken post-draft out, single-use mode cards in the bot (L7) ([#4383](https://github.com/8gi-foundation/8gent-code/pull/4383))
- read_file: footer naming unread local imports and importers ([#4352](https://github.com/8gi-foundation/8gent-code/pull/4352))
- speak: each tab's 8gent speaks in its own allowlisted voice (#4349) ([#4350](https://github.com/8gi-foundation/8gent-code/pull/4350))
- eight: message_boardroom tool, mid-task note to the boardroom ([#4345](https://github.com/8gi-foundation/8gent-code/pull/4345))
- g8way: config-driven upstreams with prefix routing and key failover ([#4341](https://github.com/8gi-foundation/8gent-code/pull/4341))
- browser: type a task-file login by placeholder, never through the shell ([#4281](https://github.com/8gi-foundation/8gent-code/pull/4281))
- post_message: direct Bot API send with a key from a configured env file (#3838) ([#3846](https://github.com/8gi-foundation/8gent-code/pull/3846))
- daemon: optional when-check gate for scheduled agent-prompt jobs, behind EIGHT_CRON_WHEN=1 (#3505) ([#3511](https://github.com/8gi-foundation/8gent-code/pull/3511))
- benchmarks: tool-call scenario gate behind EIGHT_TOOL_GATE=1 (#3489) ([#3493](https://github.com/8gi-foundation/8gent-code/pull/3493))
- harness-cli: flag-off tiered doctor report for the harness doctor (#3451) ([#3453](https://github.com/8gi-foundation/8gent-code/pull/3453))
- deck: flag-off reference-video breakdown, step 1 (#3445) ([#3450](https://github.com/8gi-foundation/8gent-code/pull/3450))
- extensions: revertible extension scope behind EIGHT_EXT_SCOPE (#3431) ([#3440](https://github.com/8gi-foundation/8gent-code/pull/3440))
- gamedev: flag-off local media capability probe as first image tier (#3422) ([#3435](https://github.com/8gi-foundation/8gent-code/pull/3435))
- voice: neural casting table, Supertonic and KittenTTS only (#3346) ([#3359](https://github.com/8gi-foundation/8gent-code/pull/3359))
- render: backend interface plus headless Chrome backend (#3346) ([#3354](https://github.com/8gi-foundation/8gent-code/pull/3354))
- decide: opt-in hosted Jev backend with local fallback and per-decision logging ([#3652](https://github.com/8gi-foundation/8gent-code/pull/3652))
- ast-index: architecture rules check over the package import graph (#3488) ([#3492](https://github.com/8gi-foundation/8gent-code/pull/3492))
- voice: heard-only voice memory behind EIGHT_VOICE_HEARD_ONLY (#3428) ([#3441](https://github.com/8gi-foundation/8gent-code/pull/3441))
- benchmarks: failure ledger and per-task gate behind EIGHT_FAILURE_LEDGER, off by default (refs #3420) ([#3426](https://github.com/8gi-foundation/8gent-code/pull/3426))
- verify: turn-end side reviewer behind EIGHT_TURN_REVIEW, off by default (refs #3419) ([#3425](https://github.com/8gi-foundation/8gent-code/pull/3425))
- agent: quick-answer lane behind EIGHT_QUICK_ANSWER, off by default (part of #3411) ([#3418](https://github.com/8gi-foundation/8gent-code/pull/3418))

### Changed
- readme: install via the one-line installers, mark npm as the old 0.17.0 build, refresh Just shipped to v0.20.0 ([#4416](https://github.com/8gi-foundation/8gent-code/pull/4416))
- daemon run: a port held by a healthy 8gent daemon is not an error (#4413) ([#4414](https://github.com/8gi-foundation/8gent-code/pull/4414))
- Refuse a placeholder retry that invents a new path (#4407) ([#4408](https://github.com/8gi-foundation/8gent-code/pull/4408))
- Reject a placeholder-folder write once instead of only warning ([#4406](https://github.com/8gi-foundation/8gent-code/pull/4406))
- Steer placeholder nudge to cd plus relative path in commands (#4403) ([#4404](https://github.com/8gi-foundation/8gent-code/pull/4404))
- Warn when a written doc invents a placeholder folder path (#4401) ([#4402](https://github.com/8gi-foundation/8gent-code/pull/4402))
- retry a model step cut at the output cap instead of ending the turn ([#4385](https://github.com/8gi-foundation/8gent-code/pull/4385))
- name the working project folder, not the harness (#4381) ([#4382](https://github.com/8gi-foundation/8gent-code/pull/4382))
- logs no longer include voice transcript text ([#4378](https://github.com/8gi-foundation/8gent-code/pull/4378))
- judge script files by their content ([#4247](https://github.com/8gi-foundation/8gent-code/pull/4247))
- unblock note keeps a help checklist short and inside the person's stated setup (#4368) ([#4369](https://github.com/8gi-foundation/8gent-code/pull/4369))
- g8way: 8j command-judge upstream example ([#4342](https://github.com/8gi-foundation/8gent-code/pull/4342))
- Bun 1.4.3 vessel base images ([#3924](https://github.com/8gi-foundation/8gent-code/pull/3924))
- folder note says rmdir is blocked, so the model names the mkdir path before it makes a folder (#4306) ([#4308](https://github.com/8gi-foundation/8gent-code/pull/4308))
- run_command: a silent login-line copy names its file and the next step (#4303) ([#4307](https://github.com/8gi-foundation/8gent-code/pull/4307))
- login note copies the password line only, so a second sed cannot clobber it (#4303) ([#4304](https://github.com/8gi-foundation/8gent-code/pull/4304))
- Nudge, do not stop, when the model repeats a call that already succeeded ([#4302](https://github.com/8gi-foundation/8gent-code/pull/4302))
- Skip --git-dir and --work-tree as git global options in the decide allowlist ([#4300](https://github.com/8gi-foundation/8gent-code/pull/4300))
- Raise the local image cap to 2560 so local vision models can read screen UI ([#4298](https://github.com/8gi-foundation/8gent-code/pull/4298))
- Keep the harness image attachment out of the secret scan input cap ([#4297](https://github.com/8gi-foundation/8gent-code/pull/4297))
- Native path: send the prompt image to a model that can see it ([#4288](https://github.com/8gi-foundation/8gent-code/pull/4288))
- Headless run: pass a declared provider's baseUrl to the session (#4283) ([#4289](https://github.com/8gi-foundation/8gent-code/pull/4289))
- make_docx, make_xlsx, make_pptx: Word, Excel and PowerPoint from a JSON spec, and read_file on them ([#4279](https://github.com/8gi-foundation/8gent-code/pull/4279))
- use_skill: the model lists and loads skills, plus a brief-to-film starter (#3593) ([#4275](https://github.com/8gi-foundation/8gent-code/pull/4275))
- post_message: attach a video, photo, gif or document from the project ([#4273](https://github.com/8gi-foundation/8gent-code/pull/4273))
- make_pdf: render in-process, no ~/.8gent/bin/make-pdf needed ([#4272](https://github.com/8gi-foundation/8gent-code/pull/4272))
- render_video_deck: house film look, officerfilm cards, captions and entrance (#4263) ([#4264](https://github.com/8gi-foundation/8gent-code/pull/4264))
- chained refusal after a cd prefix keeps the folder (#4260) ([#4261](https://github.com/8gi-foundation/8gent-code/pull/4261))
- slides note steers to deck render, never a script (#4245) ([#4259](https://github.com/8gi-foundation/8gent-code/pull/4259))
- tg-send lane accepts one multi-line message literal (#4250) ([#4258](https://github.com/8gi-foundation/8gent-code/pull/4258))
- clone lane admits one trailing head/tail display filter (#4253) ([#4257](https://github.com/8gi-foundation/8gent-code/pull/4257))
- durable work queue in front of the session pool (flag, default off) ([#4255](https://github.com/8gi-foundation/8gent-code/pull/4255))
- parse gate for excluded files, delete unreachable broken files (from Artale, forge #32) ([#4252](https://github.com/8gi-foundation/8gent-code/pull/4252))
- brand: scope the hue ban to colours we author ([#3771](https://github.com/8gi-foundation/8gent-code/pull/3771))
- BODY.md maps eyes, hands, handeyes, computer, 8gent-computer CUA and 8gent Browser ([#3590](https://github.com/8gi-foundation/8gent-code/pull/3590))
- [permissions] System One passes plain ffmpeg builds of a new media file from workspace files (L6 media) ([#3960](https://github.com/8gi-foundation/8gent-code/pull/3960))
- give model-run commands a minimal environment ([#3869](https://github.com/8gi-foundation/8gent-code/pull/3869))

### Fixed
- ai: harness profile think field, local qwen3.8:27b-mlx answers with thinking off (#4462) ([#4463](https://github.com/8gi-foundation/8gent-code/pull/4463))
- cron: catch up once when a scheduled slot was missed ([#4464](https://github.com/8gi-foundation/8gent-code/pull/4464))
- ai: MiniMax M3 cloud output cap 32768 so reasoning steps stop ending on length (#4450) ([#4451](https://github.com/8gi-foundation/8gent-code/pull/4451))
- agent: the empty-turn continue quotes this turn's request back (#4444) ([#4447](https://github.com/8gi-foundation/8gent-code/pull/4447))
- prompt: default mode completes the task instead of outputting a plan (#4448) ([#4449](https://github.com/8gi-foundation/8gent-code/pull/4449))
- agent: a native turn that ends empty after tool calls gets one auto-continue (#4444) ([#4446](https://github.com/8gi-foundation/8gent-code/pull/4446))
- permissions: accept a lone quoted heredoc file write, refuse every other heredoc, lead refusals with the form ([#4443](https://github.com/8gi-foundation/8gent-code/pull/4443))
- permissions: cd-prefix accepts an absolute folder that resolves inside the project (#4437) ([#4438](https://github.com/8gi-foundation/8gent-code/pull/4438))
- agent: the turn-budget notice fires with two slow steps to spare, not one (#4431) ([#4435](https://github.com/8gi-foundation/8gent-code/pull/4435))
- permissions: the browser-token rule judges tokens that hold .8gent, not the rest of the command ([#4434](https://github.com/8gi-foundation/8gent-code/pull/4434))
- agent: the turn-budget notice reaches the TUI text-tool path (#4431) ([#4433](https://github.com/8gi-foundation/8gent-code/pull/4433))
- browser: a type step by index is sent as a selector 8gent Browser can use (#4426) ([#4428](https://github.com/8gi-foundation/8gent-code/pull/4428))
- permissions: a lone {name} word is not a brace glob over .8gent in the browser-token rule (#4423) ([#4429](https://github.com/8gi-foundation/8gent-code/pull/4429))
- permissions: no approval card for read-only inline python; say what to do after a missing cd folder ([#4422](https://github.com/8gi-foundation/8gent-code/pull/4422))
- browser: verify a type into a password field without reading its hidden value (#4417) ([#4424](https://github.com/8gi-foundation/8gent-code/pull/4424))
- browser: file-secret fill from .tmp KEY=value files, and sed regexes no longer trip the browser-token rule ([#4420](https://github.com/8gi-foundation/8gent-code/pull/4420))
- speak: find the account home from passwd, not $HOME, so Bun under a per-run HOME still narrates ([#4392](https://github.com/8gi-foundation/8gent-code/pull/4392))
- tools: render_video_deck writes chapters.txt and leads with its input shape (#4389) ([#4390](https://github.com/8gi-foundation/8gent-code/pull/4390))
- read_file: links footer is one to-do list in reading order (#4351) ([#4367](https://github.com/8gi-foundation/8gent-code/pull/4367))
- chat,run,tui: honour the provider and model saved in onboarding, say when a fallback happens ([#4365](https://github.com/8gi-foundation/8gent-code/pull/4365))
- npm: inline table and registry schema.sql, gate packed install on chat/run and .sql reads (#4354, #4355, #4356) ([#4359](https://github.com/8gi-foundation/8gent-code/pull/4359))
- read_file: name an importer's own unread imports in the links footer ([#4353](https://github.com/8gi-foundation/8gent-code/pull/4353))
- speak: run TTS engines against the account home so a sandboxed HOME still narrates ([#4348](https://github.com/8gi-foundation/8gent-code/pull/4348))
- generate share and approval tokens with crypto randomness ([#4343](https://github.com/8gi-foundation/8gent-code/pull/4343))
- tui: make the launch update check opt-in, no network call by default ([#4339](https://github.com/8gi-foundation/8gent-code/pull/4339))
- eight: skip the forced planning gate for single-goal prompts under 400 chars ([#4249](https://github.com/8gi-foundation/8gent-code/pull/4249))
- browser: pick the 8gent Browser build that can run a named profile (#3589) ([#4251](https://github.com/8gi-foundation/8gent-code/pull/4251))
- run_command: the login-copy notes say post with no -L (#4328) ([#4329](https://github.com/8gi-foundation/8gent-code/pull/4329))
- run_command: say no -L on a loopback form after the page fetch (#4326) ([#4327](https://github.com/8gi-foundation/8gent-code/pull/4327))
- run_command: a value-only login copy says it has no field name (#4324) ([#4325](https://github.com/8gi-foundation/8gent-code/pull/4325))
- run_command: Windows: refuse non-regular files before open (#4322) ([#4323](https://github.com/8gi-foundation/8gent-code/pull/4323))
- tools: hold a ticket that names two source files once for a trim (#4320) ([#4321](https://github.com/8gi-foundation/8gent-code/pull/4321))
- run_command: name the redirect target of a curl -D dump header (#4318) ([#4319](https://github.com/8gi-foundation/8gent-code/pull/4319))
- eight: scratch dir never edits .git; ticket note names one file (#4316) ([#4317](https://github.com/8gi-foundation/8gent-code/pull/4317))
- compare_layout: never launch the user's own browser, refuse inside a macOS sandbox (#4313) ([#4314](https://github.com/8gi-foundation/8gent-code/pull/4314))
- eight: instruction walk-up stops at $HOME and never probes / or autofs roots ([#4312](https://github.com/8gi-foundation/8gent-code/pull/4312))
- eight: send the original image size and say so when it is downscaled (#4293) ([#4294](https://github.com/8gi-foundation/8gent-code/pull/4294))
- permissions: tg-send lane accepts a set -e line after the shebang (#4232) ([#4246](https://github.com/8gi-foundation/8gent-code/pull/4246))
- eight: write .tmp/ to info/exclude lazily, not at session start (#4241) ([#4242](https://github.com/8gi-foundation/8gent-code/pull/4242))
- tools: do not overwrite a file a refused probe named (#4238) ([#4239](https://github.com/8gi-foundation/8gent-code/pull/4239))
- scratch: keep .tmp/ git-ignored via .git/info/exclude so scratch never dirties the tree ([#4237](https://github.com/8gi-foundation/8gent-code/pull/4237))
- compare_layout: clear stale Chrome locks, private TMPDIR, say the lock is handled ([#4235](https://github.com/8gi-foundation/8gent-code/pull/4235))
- test: make update-notice test hermetic (main red after v0.20.0) ([#4231](https://github.com/8gi-foundation/8gent-code/pull/4231))
- memory: widen redaction key patterns ([#3446](https://github.com/8gi-foundation/8gent-code/pull/3446))
- cli: doctor resolves ~/.8gent via resolveHome (refs #3394) ([#3408](https://github.com/8gi-foundation/8gent-code/pull/3408))
- db: git-ignore the workspace state DB and its WAL/SHM files (#3302) ([#3309](https://github.com/8gi-foundation/8gent-code/pull/3309))
- run: exit non-zero when the turn ends in a failure reply ([#3901](https://github.com/8gi-foundation/8gent-code/pull/3901))
- eight: native attempt idle gap plus turn budget, not flat 300 s (#3855) ([#3857](https://github.com/8gi-foundation/8gent-code/pull/3857))
- eight: read_image layout gives per-line tops beside images and column offsets for inset cells (#3823) ([#3824](https://github.com/8gi-foundation/8gent-code/pull/3824))
- tui: status line shows the model's real context window (#3321) ([#3791](https://github.com/8gi-foundation/8gent-code/pull/3791))
- tui: measure chat rows in terminal cells, not code points ([#3543](https://github.com/8gi-foundation/8gent-code/pull/3543))
- mcp: time out and abort SSE transport requests (#3533) ([#3534](https://github.com/8gi-foundation/8gent-code/pull/3534))
- agent: a stop pressed at any point in a turn is honoured (#3521) ([#3530](https://github.com/8gi-foundation/8gent-code/pull/3530))
- smoke: run settings checks under a temp EIGHT_HOME, never the real settings file (#3393) ([#3516](https://github.com/8gi-foundation/8gent-code/pull/3516))

## [0.20.0] - 2026-10-13

### Added
- voice: mic follows the current input device and shows which one ([#3835](https://github.com/8gi-foundation/8gent-code/pull/3835))
- onboarding: find llama-server and LM Studio on every OS, offer a choice, save it ([#4216](https://github.com/8gi-foundation/8gent-code/pull/4216))
- eight: post_message checks the draft against the task's countable rules before it sends (#4191) ([#4197](https://github.com/8gi-foundation/8gent-code/pull/4197))
- daemon: live anatomy page at /live, opened from the TUI with Ctrl+F (#4190) ([#4194](https://github.com/8gi-foundation/8gent-code/pull/4194))
- deck: 8gent deck render spec.json, the deterministic renderer from the shell ([#4084](https://github.com/8gi-foundation/8gent-code/pull/4084))
- browser: local models get 8gent Browser tools through an on-demand isolated profile (#3785) ([#4067](https://github.com/8gi-foundation/8gent-code/pull/4067))
- tools: compare_layout renders the page and reports per-block offsets against the mock-up ([#4081](https://github.com/8gi-foundation/8gent-code/pull/4081))
- daemon: continue an interrupted turn once after a crash ([#4085](https://github.com/8gi-foundation/8gent-code/pull/4085))
- tools: render_video_deck renders a JSON spec into a video deterministically ([#4076](https://github.com/8gi-foundation/8gent-code/pull/4076))
- update: 8gent update pulls and rebuilds source checkouts, including 8gent Browser ([#4079](https://github.com/8gi-foundation/8gent-code/pull/4079))
- computer: desktop_act, grounded desktop acting through the local grounder, approval in every mode ([#4057](https://github.com/8gi-foundation/8gent-code/pull/4057))
- eyes: chooseElement, closed-option grounding with the local decider ([#4055](https://github.com/8gi-foundation/8gent-code/pull/4055))
- eyes: screen_locate tool, planner names a target, grounder returns the point ([#4048](https://github.com/8gi-foundation/8gent-code/pull/4048))
- eyes: local grounding service, ground(screenshot, instruction) -> point, 96% on our own pages ([#4061](https://github.com/8gi-foundation/8gent-code/pull/4061))
- eight: completion self-check before a turn ends ([#3955](https://github.com/8gi-foundation/8gent-code/pull/3955))
- daemon: restricted no-tools classroom channel (#3939) ([#3940](https://github.com/8gi-foundation/8gent-code/pull/3940))
- daemon,tui: shared sessions across the TUI and the browser panel ([#3930](https://github.com/8gi-foundation/8gent-code/pull/3930))
- tui: step_start and durationMs on step_finish in the TUI session log ([#3913](https://github.com/8gi-foundation/8gent-code/pull/3913))
- session: log step_start before each model call and measured durationMs on step_end (Closes #3910) ([#3911](https://github.com/8gi-foundation/8gent-code/pull/3911))
- eight: re-surface an ignored retired-fact warning once at turn end (Refs #3811) ([#3889](https://github.com/8gi-foundation/8gent-code/pull/3889))
- eight: warn when a write copies a retired date or number (#3811) ([#3887](https://github.com/8gi-foundation/8gent-code/pull/3887))
- tools: browser_task types secrets by placeholder, resolved locally (#3604) ([#3795](https://github.com/8gi-foundation/8gent-code/pull/3795))
- prompt: review-task guidance, report only findings that matter (#3786) ([#3789](https://github.com/8gi-foundation/8gent-code/pull/3789))
- tui: emit OSC 7501 program status ([#3738](https://github.com/8gi-foundation/8gent-code/pull/3738))
- decide: opt-in NeuDecide audio router for voice commands ([#3704](https://github.com/8gi-foundation/8gent-code/pull/3704))
- daemon: replay class per tool so crash resume never repeats a side effect (#3653) ([#3698](https://github.com/8gi-foundation/8gent-code/pull/3698))
- eight: stale-output handles behind EIGHT_OBSERVATION_PACK (#3477) ([#3696](https://github.com/8gi-foundation/8gent-code/pull/3696))
- ai: answer-only after a useless tool streak behind EIGHT_USELESS_STREAK (#3613) ([#3691](https://github.com/8gi-foundation/8gent-code/pull/3691))
- tui: real terminal background (OSC 11) and design-system themes via /theme (#3754) ([#3764](https://github.com/8gi-foundation/8gent-code/pull/3764))
- browser: EIGHT_BROWSER_PROFILE points browser tools at an isolated profile (#3622) ([#3623](https://github.com/8gi-foundation/8gent-code/pull/3623))
- film-craft: film presets and an original music bed for designed slide videos (#3599) ([#3609](https://github.com/8gi-foundation/8gent-code/pull/3609))
- browser: browser_* drive 8gent Browser with action spec, dry run and verify-after-act ([#3592](https://github.com/8gi-foundation/8gent-code/pull/3592))
- tools: speak tool over local neural TTS ([#3601](https://github.com/8gi-foundation/8gent-code/pull/3601))
- eight: post_message tool over tg-group and say-telegram ([#3602](https://github.com/8gi-foundation/8gent-code/pull/3602))
- design-systems: import-ready Marp deck themes and deck_theme tool ([#3600](https://github.com/8gi-foundation/8gent-code/pull/3600))
- daemon: per-session queue instead of refusing busy sessions (opt-in) ([#3570](https://github.com/8gi-foundation/8gent-code/pull/3570))
- mcp: speak the 2026-07-28 protocol with the old handshake as fallback ([#3565](https://github.com/8gi-foundation/8gent-code/pull/3565))
- prompts: restate the communication style last on local text-tool requests ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- prompts: opt-in action-first communication style ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- autoresearch: speed-change gate behind EIGHT_SPEED_GATE=1 (trial, not measured) ([#3470](https://github.com/8gi-foundation/8gent-code/pull/3470))
- providers: flag-off decision-readout judge via llama.cpp /v1/systemone (#3455) ([#3457](https://github.com/8gi-foundation/8gent-code/pull/3457))
- cron: automation blueprints behind EIGHT_BLUEPRINTS=1 (trial, saves only) ([#3468](https://github.com/8gi-foundation/8gent-code/pull/3468))
- providers: effort by task kind behind EIGHT_EFFORT_POLICY=1 (trial, off by default) ([#3464](https://github.com/8gi-foundation/8gent-code/pull/3464))
- 8dk: device kit so any device can give a vessel gated capabilities ([#3362](https://github.com/8gi-foundation/8gent-code/pull/3362))
- orchestration: childAgentEnv and process depth refusal helpers (#3341) ([#3347](https://github.com/8gi-foundation/8gent-code/pull/3347))

### Changed
- llama-server router mode: /llama status, /models use, loopback guard ([#4215](https://github.com/8gi-foundation/8gent-code/pull/4215))
- Windows RTX llama-server section in ARTALE-WINDOWS ([#4207](https://github.com/8gi-foundation/8gent-code/pull/4207))
- compare_layout: name the element behind each off band (#4204) ([#4205](https://github.com/8gi-foundation/8gent-code/pull/4205))
- prefill meter: per-round prefill and generation counts in the session log behind EIGHT_PREFIX_METER=1 (#3655) ([#4203](https://github.com/8gi-foundation/8gent-code/pull/4203))
- edit_file: content-hash anchored edits behind EIGHT_EDIT_FORMAT=hashline (flag off by default) ([#4202](https://github.com/8gi-foundation/8gent-code/pull/4202))
- tool catalog: every first sentence carries the input shape within 140 chars (retro 13 Oct) ([#4200](https://github.com/8gi-foundation/8gent-code/pull/4200))
- permissions: lock the #4173 in-line variable exclusions the suites did not cover ([#4193](https://github.com/8gi-foundation/8gent-code/pull/4193))
- prompt: a checklist file the task points at is the record, not the rail (#4161) ([#4164](https://github.com/8gi-foundation/8gent-code/pull/4164))
- ci: the pin assertion enumerates every workflow, not a hand-written list (carried from forge #31) ([#4157](https://github.com/8gi-foundation/8gent-code/pull/4157))
- make the secrets scan, policy integrity and dependency audit steps tell the truth (carried from forge #30) ([#4152](https://github.com/8gi-foundation/8gent-code/pull/4152))
- SHA-pin the last 20 mutable action refs, leaving none (carried from forge #29) ([#4149](https://github.com/8gi-foundation/8gent-code/pull/4149))
- terminal-tab: skip pty-session tests with a reason when node-pty or a pty is unavailable (#3458) ([#3460](https://github.com/8gi-foundation/8gent-code/pull/3460))
- preflight node-pty before the suite and name the missing module when the bridge exits 66 (#4143) ([#4146](https://github.com/8gi-foundation/8gent-code/pull/4146))
- typecheck the TUI's .sql declarations and gate typecheck:tui plus changed-file biome checks (#4135) ([#4140](https://github.com/8gi-foundation/8gent-code/pull/4140))
- authorship guard scoped to the PR's own commits ([#4089](https://github.com/8gi-foundation/8gent-code/pull/4089))
- [pi-modules] Pi parity A5 D6 D8 D11 modules: changelog, external editor, user keybindings, local bug report ([#4038](https://github.com/8gi-foundation/8gent-code/pull/4038))
- [pi-themes] Wire user themes into /theme picker and /reload ([#4070](https://github.com/8gi-foundation/8gent-code/pull/4070))
- [pi-L2][permissions] Windows runtime: Git Bash default, shell-aware permissions, OS and shell in the prompt ([#3979](https://github.com/8gi-foundation/8gent-code/pull/3979))
- [pi-win] Retry and idle timeout from settings (C4); project settings over global through an allowlist (N2) ([#4049](https://github.com/8gi-foundation/8gent-code/pull/4049))
- [pi-cli] 8gent update through self-update; install npm:<name>@<version>; packages list/remove (A2, G2) ([#4056](https://github.com/8gi-foundation/8gent-code/pull/4056))
- [permissions] [pi-l5] One-file TypeScript extensions: add a tool, add a command, block a tool call ([#4000](https://github.com/8gi-foundation/8gent-code/pull/4000))
- [permissions] fix: protect ~/.8gent hooks, extensions, prompts and packages from model writes ([#4010](https://github.com/8gi-foundation/8gent-code/pull/4010))
- [permissions] fix(ai): native git and gh tools run as argv, no shell (#3998) ([#4001](https://github.com/8gi-foundation/8gent-code/pull/4001))
- permissions: System One keeps allowing every command of the passing pilot runs ([#3958](https://github.com/8gi-foundation/8gent-code/pull/3958))
- [permissions] fix(eight): edit_file applies a unique whitespace-only match instead of failing ([#3962](https://github.com/8gi-foundation/8gent-code/pull/3962))
- [pi-tui] Sessions on the tree store: /resume picker, /tree, /fork, /export and /import JSONL (E1 E3 E4 E7) ([#4062](https://github.com/8gi-foundation/8gent-code/pull/4062))
- [permissions] feat: OS sandbox denies run_command writes to ~/.8gent startup and secret paths (#4009, #3612) ([#4013](https://github.com/8gi-foundation/8gent-code/pull/4013))
- [pi-l7] docs: user guide for developers coming from Pi ([#3972](https://github.com/8gi-foundation/8gent-code/pull/3972))
- [pi-themes] User themes from ~/.8gent/themes/*.json (N1) ([#4042](https://github.com/8gi-foundation/8gent-code/pull/4042))
- [pi-tui] Prompt templates as /name in the slash menu (G4) ([#4063](https://github.com/8gi-foundation/8gent-code/pull/4063))
- [pi-skills] Discover .agents/skills and run a skill with /skill:name (#4046) ([#4047](https://github.com/8gi-foundation/8gent-code/pull/4047))
- [pi-compact] One compaction path, recorded in the session store (E5) ([#4051](https://github.com/8gi-foundation/8gent-code/pull/4051))
- [pi-L6] /copy and /hotkeys in the core menu, Prompt group in /hotkeys ([#4033](https://github.com/8gi-foundation/8gent-code/pull/4033))
- [pi-l3] Headless front door: -p with piped stdin, --mode json, --continue per folder, --tools, pet opt-in ([#3978](https://github.com/8gi-foundation/8gent-code/pull/3978))
- [pi-L6] !cmd runs a shell command into the next message, !!cmd runs it locally ([#3999](https://github.com/8gi-foundation/8gent-code/pull/3999))
- [pi-L6] @ lists matching project files, Tab inserts the path ([#4005](https://github.com/8gi-foundation/8gent-code/pull/4005))
- [pi-l1] Release pipeline: hosted runners, npm trusted publishing, Windows exe smoke, failure alarm ([#3987](https://github.com/8gi-foundation/8gent-code/pull/3987))
- [pi-l1] Self-update that never installs a lower version; CHANGELOG ships in the package and binary ([#3994](https://github.com/8gi-foundation/8gent-code/pull/3994))
- [pi-L6] /copy puts the last answer on the clipboard via OSC 52 ([#3996](https://github.com/8gi-foundation/8gent-code/pull/3996))
- [pi-L4] SessionPicker and SessionTree components (search, rename, delete, /tree) ([#3991](https://github.com/8gi-foundation/8gent-code/pull/3991))
- [pi-L6] Ctrl+L model picker that draws, /hotkeys from one key table ([#3990](https://github.com/8gi-foundation/8gent-code/pull/3990))
- [pi-L6] / menu shows core commands only, /help all lists the rest ([#3982](https://github.com/8gi-foundation/8gent-code/pull/3982))
- drop the unused bun cache volume from Linux (Docker) ([#4030](https://github.com/8gi-foundation/8gent-code/pull/4030))
- [permissions] fix(ai): native run_command shares the text path's pre-spawn backstops (#3993) ([#3997](https://github.com/8gi-foundation/8gent-code/pull/3997))
- run Linux (Docker) and Clean install on GitHub-hosted ubuntu-latest ([#4028](https://github.com/8gi-foundation/8gent-code/pull/4028))
- [pi-l1] One-line installers for Windows, macOS and Linux ([#3983](https://github.com/8gi-foundation/8gent-code/pull/3983))
- [pi-L4] Sessions on the JSONL tree: non-destructive saves, undoable compaction, JSONL export/import ([#3986](https://github.com/8gi-foundation/8gent-code/pull/3986))
- [pi-l5] A refused tool call never runs on the native path (PreToolUse block was a no-op) ([#3985](https://github.com/8gi-foundation/8gent-code/pull/3985))
- [pi-l5] Install npm:name@version into ~/.8gent/packages, pinned by integrity ([#4002](https://github.com/8gi-foundation/8gent-code/pull/4002))
- [pi-l5] Prompt templates: ~/.8gent/prompts/*.md become /name commands ([#4004](https://github.com/8gi-foundation/8gent-code/pull/4004))
- [pi-l5] Steer a running turn: the message lands after the current tool call ([#3977](https://github.com/8gi-foundation/8gent-code/pull/3977))
- [pi-L4] JSONL tree session store: listSessions, latestSessionForCwd, branch, fork ([#3974](https://github.com/8gi-foundation/8gent-code/pull/3974))
- Bun 1.4.3 ([#3923](https://github.com/8gi-foundation/8gent-code/pull/3923))
- pin oven-sh/setup-bun to commit SHA ([#3925](https://github.com/8gi-foundation/8gent-code/pull/3925))
- windows: one real task end to end on the standalone exe ([#3893](https://github.com/8gi-foundation/8gent-code/pull/3893))
- permissions: corpus test for run_command decisions across modes ([#3891](https://github.com/8gi-foundation/8gent-code/pull/3891))
- eight: run the PII egress gate test against a local listener ([#3794](https://github.com/8gi-foundation/8gent-code/pull/3794))
- windows: shallow-clone smoke and standalone .exe artifact ([#3783](https://github.com/8gi-foundation/8gent-code/pull/3783))
- eight: provider-pinned grants the hosted opt-in so main Validate is green (#3804) ([#3805](https://github.com/8gi-foundation/8gent-code/pull/3805))
- guides: install and first prompt for a stranger on the npm path ([#3781](https://github.com/8gi-foundation/8gent-code/pull/3781))
- run: lean system prompt for headless local runs (#3695) ([#3699](https://github.com/8gi-foundation/8gent-code/pull/3699))
- clean-container install check for published releases ([#3745](https://github.com/8gi-foundation/8gent-code/pull/3745))
- ai: find the #3553 CHANGELOG entry in any section, not only Unreleased ([#3665](https://github.com/8gi-foundation/8gent-code/pull/3665))
- speak: accept the safePath symlink refusal from #3610 (#3617) ([#3619](https://github.com/8gi-foundation/8gent-code/pull/3619))
- release: build CHANGELOG.md at release from merged PR titles (#3575) ([#3576](https://github.com/8gi-foundation/8gent-code/pull/3576))
- changelog: qualify the per-request reroute check to local runtimes ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- Merge pull request #3410 from 8gi-foundation/fix/3402-verify-before-commit ([#3410](https://github.com/8gi-foundation/8gent-code/pull/3410))
- Merge pull request #3484 from 8gi-foundation/feat/mcp-lean ([#3484](https://github.com/8gi-foundation/8gent-code/pull/3484))
- Merge pull request #3483 from 8gi-foundation/fix/mcp-stdio-transport ([#3483](https://github.com/8gi-foundation/8gent-code/pull/3483))
- Merge pull request #3396 from 8gi-foundation/fix/3391-settings-resolve-home ([#3396](https://github.com/8gi-foundation/8gent-code/pull/3396))
- 8dk: add packages/8dk workspace to bun.lock ([#3362](https://github.com/8gi-foundation/8gent-code/pull/3362))

### Fixed
- tools: edit_file first sentence teaches in-place replacement (#4198) ([#4199](https://github.com/8gi-foundation/8gent-code/pull/4199))
- permissions: .tmp is the one sanctioned scratch directory for System One (#4185) ([#4196](https://github.com/8gi-foundation/8gent-code/pull/4196))
- update: npm channel sees GitHub releases and installs into its own prefix ([#4187](https://github.com/8gi-foundation/8gent-code/pull/4187))
- permissions: workspace boundary refuses empty and unrun loop bindings, and a cd that lands on - ([#4186](https://github.com/8gi-foundation/8gent-code/pull/4186))
- permissions: System One magick lane refuses FONTCONFIG_SYSROOT into the workspace ([#4184](https://github.com/8gi-foundation/8gent-code/pull/4184))
- run: render_video_deck catalog line names its spec shape; breaker and watchdog stops fail the run (#4172) ([#4174](https://github.com/8gi-foundation/8gent-code/pull/4174))
- permissions: approval cards show a cd-prefixed command folder first (#4178) ([#4181](https://github.com/8gi-foundation/8gent-code/pull/4181))
- permissions: System One lane for magick and convert renders inside the workspace (#4177) ([#4180](https://github.com/8gi-foundation/8gent-code/pull/4180))
- permissions: workspace boundary reads in-line variable assignments (#4173) ([#4176](https://github.com/8gi-foundation/8gent-code/pull/4176))
- permissions: deck-render lane checks PATH against the project root in the cd form (#4169) ([#4171](https://github.com/8gi-foundation/8gent-code/pull/4171))
- permissions: tg-notify send script to a loopback Bot API, refuse a bot token in curl argv (#4101) ([#4102](https://github.com/8gi-foundation/8gent-code/pull/4102))
- run_command: one leading cd <folder> && runs the rest in that folder (#3199) ([#4167](https://github.com/8gi-foundation/8gent-code/pull/4167))
- tools: render_video_deck reports measured size and stream lengths, and can be discovered (#4165) ([#4166](https://github.com/8gi-foundation/8gent-code/pull/4166))
- plan: a checklist plan file in the project is the plan of record for update_plan (#4161) ([#4162](https://github.com/8gi-foundation/8gent-code/pull/4162))
- permissions: System One lane for running a script the session wrote in .tmp (#4121) ([#4123](https://github.com/8gi-foundation/8gent-code/pull/4123))
- permissions: deterministic lane for rm -r of a directory the session made with mkdir (#4105) ([#4106](https://github.com/8gi-foundation/8gent-code/pull/4106))
- browser: stop a launch that publishes no port; refuse builds without named profiles (#4103) ([#4104](https://github.com/8gi-foundation/8gent-code/pull/4104))
- media: narration enumerates every brief point and refuses to render with one missing (#4154) ([#4158](https://github.com/8gi-foundation/8gent-code/pull/4158))
- terminal-tab: require an executable node, name the runtimes the preflight checked, and pin the managed version by test (#4147) ([#4150](https://github.com/8gi-foundation/8gent-code/pull/4150))
- cli: clear the six harness type errors in bin/8gent.ts and gate check:harness (#4135) ([#4138](https://github.com/8gi-foundation/8gent-code/pull/4138))
- lint: clear the 10 biome errors that landed while ci.yml was unparseable (#4117) ([#4119](https://github.com/8gi-foundation/8gent-code/pull/4119))
- daemon: goal resume fails closed after a hard kill, conformance on ubuntu, macOS and Windows (#4113) ([#4116](https://github.com/8gi-foundation/8gent-code/pull/4116))
- skills: a project skill cannot silently replace a bundled one (#4125) ([#4126](https://github.com/8gi-foundation/8gent-code/pull/4126))
- daemon: crash-resume note says what is knowable about a call's replay class (#4118) ([#4120](https://github.com/8gi-foundation/8gent-code/pull/4120))
- daemon: resolve every state path through getDataDir so Windows without HOME stays out of the cwd (#4111) ([#4112](https://github.com/8gi-foundation/8gent-code/pull/4112))
- daemon: Windows kill-and-resume proof, resume-on-boot on for the Scheduled Task (#4107) ([#4108](https://github.com/8gi-foundation/8gent-code/pull/4108))
- daemon: read config.json via getDataDir so Windows without HOME finds it (#4109) ([#4110](https://github.com/8gi-foundation/8gent-code/pull/4110))
- tests: portable windows-latest suite, deterministic living-mark beat (#4094) ([#4098](https://github.com/8gi-foundation/8gent-code/pull/4098))
- browser: pre-flight the host sandbox and keep Chromium's fatal line when 8gent Browser cannot start (#4099) ([#4100](https://github.com/8gi-foundation/8gent-code/pull/4100))
- permissions: deterministic lanes for the login-note sed recipe and a curl output name (#4072) ([#4096](https://github.com/8gi-foundation/8gent-code/pull/4096))
- safety: process substitution refused like command substitution; browser-secret guard matches only browser state paths ([#4092](https://github.com/8gi-foundation/8gent-code/pull/4092))
- release: never fail the release on a missing PACK_SMOKE_OWNER_IDENTITY; alarm when the npm channel does not publish ([#4087](https://github.com/8gi-foundation/8gent-code/pull/4087))
- tui: write 8gent in on-screen copy ([#4093](https://github.com/8gi-foundation/8gent-code/pull/4093))
- prompt: login note and repeated-chaining count for a local web app sign-in (#4072) ([#4091](https://github.com/8gi-foundation/8gent-code/pull/4091))
- run_command: name the -L refusal in the chaining block so the curl is not resent with -L ([#4086](https://github.com/8gi-foundation/8gent-code/pull/4086))
- system-one: allow in-workspace mv/cp and local git clone before the judge ([#4074](https://github.com/8gi-foundation/8gent-code/pull/4074))
- permissions: curl -L follows redirects only to the run's listed loopback servers, with a clear refusal otherwise (#3967) ([#4068](https://github.com/8gi-foundation/8gent-code/pull/4068))
- ci: main's Linux and Windows test failures ([#4058](https://github.com/8gi-foundation/8gent-code/pull/4058))
- extensions: reserve the built-in /import command ([#4071](https://github.com/8gi-foundation/8gent-code/pull/4071))
- permissions: System One loopback curl lane allows one trailing grep/head/tail/wc filter ([#3947](https://github.com/8gi-foundation/8gent-code/pull/3947))
- permissions: System One allows git mv, multi-source mv and local git clone inside the workspace ([#3827](https://github.com/8gi-foundation/8gent-code/pull/3827))
- prompt: put the local-server curl rules in the compact local prompt ([#4066](https://github.com/8gi-foundation/8gent-code/pull/4066))
- hooks: a YAML hook that ignores stdin no longer throws an uncaught EPIPE ([#4064](https://github.com/8gi-foundation/8gent-code/pull/4064))
- tools: browser-secret guard allows commands whose path has a browser-named directory after .8gent ([#3952](https://github.com/8gi-foundation/8gent-code/pull/3952))
- eight: attached mock-up images get the measured layout too (#3823) ([#3956](https://github.com/8gi-foundation/8gent-code/pull/3956))
- prompts: local models get the loopback curl rules through the withheld-browser note (#4034) ([#4035](https://github.com/8gi-foundation/8gent-code/pull/4035))
- smoke: bound the TUI first-frame check so it cannot hang a hosted runner ([#4012](https://github.com/8gi-foundation/8gent-code/pull/4012))
- permissions: quoted text is data for the run_command sanitiser (#3879) ([#3880](https://github.com/8gi-foundation/8gent-code/pull/3880))
- permissions: System One passes rm -f and mv of the task's own generated data files (#3943) ([#3944](https://github.com/8gi-foundation/8gent-code/pull/3944))
- permissions: System One allowlists loopback-only requests to the scenario's own web stub (#3941) ([#3942](https://github.com/8gi-foundation/8gent-code/pull/3942))
- permissions: System One passes a plain run of the project's own script ([#3938](https://github.com/8gi-foundation/8gent-code/pull/3938))
- tools: let grep regexes and /dev/null redirects through the run_command guards (#3934) ([#3935](https://github.com/8gi-foundation/8gent-code/pull/3935))
- permissions: allow semicolon inside quotes in run_command sanitizer ([#3932](https://github.com/8gi-foundation/8gent-code/pull/3932))
- permissions: protect session records from tool writes ([#3926](https://github.com/8gi-foundation/8gent-code/pull/3926))
- npm install works in a fresh clone (workspace:* to *) ([#3928](https://github.com/8gi-foundation/8gent-code/pull/3928))
- prompt: reviews cite only the lines that must change (#3920) ([#3921](https://github.com/8gi-foundation/8gent-code/pull/3921))
- daemon: daemon run listens on loopback; Windows CI proves the exe daemon ([#3903](https://github.com/8gi-foundation/8gent-code/pull/3903))
- providers: apfel counts as hosted unless its base URL is loopback ([#3909](https://github.com/8gi-foundation/8gent-code/pull/3909))
- tests: remaining Windows failures on main, one real permissions bug (Refs #3814) ([#3896](https://github.com/8gi-foundation/8gent-code/pull/3896))
- eight: refuse edit_file when oldText matches more than once (#3898) ([#3902](https://github.com/8gi-foundation/8gent-code/pull/3902))
- binary: embed the TUI in compiled binaries, smoke-test first frame ([#3894](https://github.com/8gi-foundation/8gent-code/pull/3894))
- release: publish the release only once the Windows .exe and every installer are on it ([#3895](https://github.com/8gi-foundation/8gent-code/pull/3895))
- orchestration: a sub-agent finishes its own scope before it ends ([#3707](https://github.com/8gi-foundation/8gent-code/pull/3707))
- tools: native read_file resolves through safePath ([#3775](https://github.com/8gi-foundation/8gent-code/pull/3775))
- run: headless run cannot report success on a red build (done gate) ([#3693](https://github.com/8gi-foundation/8gent-code/pull/3693))
- eight: a blank model reply is a failed turn, not a finished one ([#3694](https://github.com/8gi-foundation/8gent-code/pull/3694))
- tests: Windows path shapes, and product paths that were wrong on Windows (#3814) ([#3818](https://github.com/8gi-foundation/8gent-code/pull/3818))
- local: give prompt prefill its own first-token budget and read Ollama's real context window (#3643) ([#3701](https://github.com/8gi-foundation/8gent-code/pull/3701))
- eight: say why a browser tool is withheld from a local model (#3785) ([#3792](https://github.com/8gi-foundation/8gent-code/pull/3792))
- orchestration: efficiency rules for pool children on a shared local model ([#3796](https://github.com/8gi-foundation/8gent-code/pull/3796))
- tests: release SQLite handles before delete and use os.tmpdir on Windows (#3814) ([#3815](https://github.com/8gi-foundation/8gent-code/pull/3815))
- tests: Windows-safe fixture names and temp roots in permissions suites (#3814) ([#3816](https://github.com/8gi-foundation/8gent-code/pull/3816))
- mcp: stdio transport shuts down when the server process exits (#3814) ([#3822](https://github.com/8gi-foundation/8gent-code/pull/3822))
- tests: Windows-aware TUI glyph expectations and POSIX-only skips (#3814) ([#3817](https://github.com/8gi-foundation/8gent-code/pull/3817))
- prompt: scratch files go in .tmp/ inside the project, not /tmp ([#3866](https://github.com/8gi-foundation/8gent-code/pull/3866))
- prompt: slides-to-video join must cover every slide ([#3864](https://github.com/8gi-foundation/8gent-code/pull/3864))
- tui: header path cut keeps the end of the workdir ([#3812](https://github.com/8gi-foundation/8gent-code/pull/3812))
- tui: edge click targets, dead gaps on the approval card (#3357) ([#3358](https://github.com/8gi-foundation/8gent-code/pull/3358))
- permissions: always-blocked check covers every segment of a command line ([#3773](https://github.com/8gi-foundation/8gent-code/pull/3773))
- permissions: System One allows an in-project mv that overwrites nothing ([#3813](https://github.com/8gi-foundation/8gent-code/pull/3813))
- eight: read_image reports measured layout so design-to-code positions match the mock-up ([#3772](https://github.com/8gi-foundation/8gent-code/pull/3772))
- tools: browser opens go through the net guard in every profile ([#3790](https://github.com/8gi-foundation/8gent-code/pull/3790))
- eight: enforce the active mode's tool restrictions on the request path (#3389) ([#3793](https://github.com/8gi-foundation/8gent-code/pull/3793))
- release: never publish an empty release; npm token preflight; CI release dry run (#3326) ([#3744](https://github.com/8gi-foundation/8gent-code/pull/3744))
- tools: read_file on a diff numbers the patched file, not the diff rows (#3722) ([#3723](https://github.com/8gi-foundation/8gent-code/pull/3723))
- decide: allowlist loopback-only curl and wget GETs (#3714) ([#3717](https://github.com/8gi-foundation/8gent-code/pull/3717))
- prompt: restore deleted tracked files from git, never retype them ([#3719](https://github.com/8gi-foundation/8gent-code/pull/3719))
- daemon: telegram poll loop always recovers ([#3709](https://github.com/8gi-foundation/8gent-code/pull/3709))
- ast-index: report forward-slash paths on every OS (#3662) ([#3675](https://github.com/8gi-foundation/8gent-code/pull/3675))
- smoke: slash dispatch coverage; wire /toolshed /quarantine; remove dead /language /sprite /animate ([#3686](https://github.com/8gi-foundation/8gent-code/pull/3686))
- specifications: resolve session dir from runtime HOME at write time (#3678) ([#3684](https://github.com/8gi-foundation/8gent-code/pull/3684))
- vision: match qwen2.5vl tags and tell the agent when image interpretation fails ([#3716](https://github.com/8gi-foundation/8gent-code/pull/3716))
- orchestration: child agents inherit the parent's local provider; hosted models require explicit opt-in ([#3712](https://github.com/8gi-foundation/8gent-code/pull/3712))
- permissions: Infinite mode asks for the ask-every-time list ([#3766](https://github.com/8gi-foundation/8gent-code/pull/3766))
- permissions: pushes to the default branch always prompt; network commands prompt under a pinned local provider ([#3757](https://github.com/8gi-foundation/8gent-code/pull/3757))
- eight: never chip a tool result that carries an image attachment ([#3740](https://github.com/8gi-foundation/8gent-code/pull/3740))
- providers: an explicitly selected provider never falls back to another provider ([#3750](https://github.com/8gi-foundation/8gent-code/pull/3750))
- tools: confine write_file and edit_file to the workspace root ([#3751](https://github.com/8gi-foundation/8gent-code/pull/3751))
- permissions: protect agent audit files from agent tools (#3735) ([#3736](https://github.com/8gi-foundation/8gent-code/pull/3736))
- eight: headless runs can use image input (#3641) ([#3677](https://github.com/8gi-foundation/8gent-code/pull/3677))
- ai: clamp timeout env values and cap streamed reply size (#3671) ([#3673](https://github.com/8gi-foundation/8gent-code/pull/3673))
- permissions: allow deleting one untracked workspace file without the judge (#3669) ([#3672](https://github.com/8gi-foundation/8gent-code/pull/3672))
- ai: time out turns on no progress, not wall time (#3657) ([#3670](https://github.com/8gi-foundation/8gent-code/pull/3670))
- ai: an update_plan-only round is not progress in the text tool loop ([#3645](https://github.com/8gi-foundation/8gent-code/pull/3645))
- release: release via PR, version past existing tags (#3658) ([#3659](https://github.com/8gi-foundation/8gent-code/pull/3659))
- mcp: follow HTTP redirects only within the configured origin ([#3635](https://github.com/8gi-foundation/8gent-code/pull/3635))
- daemon: close the Telegram approval loop ([#3624](https://github.com/8gi-foundation/8gent-code/pull/3624))
- telegram: sender tiers, no shell from groups, local model default (#3615) ([#3616](https://github.com/8gi-foundation/8gent-code/pull/3616))
- eight: safePath refuses symlink escapes from the workspace ([#3610](https://github.com/8gi-foundation/8gent-code/pull/3610))
- eight: edit_file returns closest matching region when old text is not found ([#3606](https://github.com/8gi-foundation/8gent-code/pull/3606))
- orchestration: sub-agents drop update_plan and check_agent waits 90s ([#3587](https://github.com/8gi-foundation/8gent-code/pull/3587))
- tools: write_file flags a new top-folder file when the work is in one folder ([#3585](https://github.com/8gi-foundation/8gent-code/pull/3585))
- tools: run_command reports the images it wrote, and any cut off ([#3584](https://github.com/8gi-foundation/8gent-code/pull/3584))
- tools: write_file reports the shape of a text file it wrote (#3580) ([#3582](https://github.com/8gi-foundation/8gent-code/pull/3582))
- providers: llama-server has no base URL on the AI SDK path ([#3581](https://github.com/8gi-foundation/8gent-code/pull/3581))
- linkedin-vessel: harden access and add an activity policy ([#3578](https://github.com/8gi-foundation/8gent-code/pull/3578))
- permissions: tighten System One rm allowances for existing files ([#3574](https://github.com/8gi-foundation/8gent-code/pull/3574))
- benchmarks: resumable, seeded benchmark runs ([#3573](https://github.com/8gi-foundation/8gent-code/pull/3573))
- autoresearch: keep only prompt rules that win on tuning without hurting held-out ([#3572](https://github.com/8gi-foundation/8gent-code/pull/3572))
- providers: provider allowlist that fails closed ([#3571](https://github.com/8gi-foundation/8gent-code/pull/3571))
- ai: streamed errors and truncated streams fail, tool-call index bounded ([#3569](https://github.com/8gi-foundation/8gent-code/pull/3569))
- daemon: resume an interrupted task after a crash or power cut ([#3568](https://github.com/8gi-foundation/8gent-code/pull/3568))
- permissions: optional filter for outside tool output ([#3567](https://github.com/8gi-foundation/8gent-code/pull/3567))
- agent: pre-completion verify gate (opt-in) ([#3566](https://github.com/8gi-foundation/8gent-code/pull/3566))
- tui: filter Ollama models that cannot chat from the picker ([#3564](https://github.com/8gi-foundation/8gent-code/pull/3564))
- providers: PII gate verifies tool-call ids, names and reply ids ([#3563](https://github.com/8gi-foundation/8gent-code/pull/3563))
- mcp: pass MCP tool schemas to the model with their real parameters ([#3562](https://github.com/8gi-foundation/8gent-code/pull/3562))
- pii: restore placeholders split across stream chunks ([#3561](https://github.com/8gi-foundation/8gent-code/pull/3561))
- mcp: restart a crashed stdio server once, or drop it ([#3560](https://github.com/8gi-foundation/8gent-code/pull/3560))
- proxy: cancel the model call when the client disconnects ([#3559](https://github.com/8gi-foundation/8gent-code/pull/3559))
- telegram: resume the daemon session on reconnect and destroy abandoned sessions ([#3558](https://github.com/8gi-foundation/8gent-code/pull/3558))
- prompts: rerouted off-box turns drop board and user-global files ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- prompts: judge on-box by the endpoint actually used ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- prompts: only known styles and language codes reach the prompt ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- prompts: user context and styles reach local text-tool models ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- prompts: action-first overrides joke completion and greeting phrases ([#3487](https://github.com/8gi-foundation/8gent-code/pull/3487))
- eight: refused commands no longer use up the 50-call breaker budget; stopped turns say so (refs #3409) ([#3413](https://github.com/8gi-foundation/8gent-code/pull/3413))
- tui,voice: intro marker and voice cache resolve ~/.8gent through resolveHome() (#3394, PR 2) ([#3407](https://github.com/8gi-foundation/8gent-code/pull/3407))
- tui: use an installed model when the 8gent default is missing (refs #3332)
- permissions: close destructive guard bypasses via variables and quoting (#3314, #3315) ([#3400](https://github.com/8gi-foundation/8gent-code/pull/3400))
- permissions: allow rm -f of a temp file the agent created this session, macOS only (#3395) ([#3401](https://github.com/8gi-foundation/8gent-code/pull/3401))
- permissions: rm -f of an absent temp path skips the System One judge (#3381) ([#3382](https://github.com/8gi-foundation/8gent-code/pull/3382))
- eight: run_command keeps stderr on exit 0 (#3373) ([#3376](https://github.com/8gi-foundation/8gent-code/pull/3376))
- tui: QA tab skips apfel off Apple Silicon (#3390) ([#3392](https://github.com/8gi-foundation/8gent-code/pull/3392))
- read_file: number every line, keep true numbers with offset/limit (#3375) ([#3383](https://github.com/8gi-foundation/8gent-code/pull/3383))
- tui: build-intent routes only new web asks to /build (#3323, #3325) ([#3361](https://github.com/8gi-foundation/8gent-code/pull/3361))
- 8dk: refuse invisible characters in device text by Unicode category ([#3362](https://github.com/8gi-foundation/8gent-code/pull/3362))
- 8dk: re-check pairing after approval, own-property lookups, bounded manifest text ([#3362](https://github.com/8gi-foundation/8gent-code/pull/3362))
- cli: refuse to start a model loop past MAX_AGENT_DEPTH (#3341) ([#3350](https://github.com/8gi-foundation/8gent-code/pull/3350))
- onboard: --yes persists onboarding complete (#3329) ([#3349](https://github.com/8gi-foundation/8gent-code/pull/3349))
- doctor: check the memory, profile and settings paths 8gent writes (#3328) ([#3345](https://github.com/8gi-foundation/8gent-code/pull/3345))
- orchestration: hard cap spawn_agent depth at 3, fail closed (#3331) ([#3343](https://github.com/8gi-foundation/8gent-code/pull/3343))
- daemon: login service definition goes under the account's home (#3293) ([#3295](https://github.com/8gi-foundation/8gent-code/pull/3295))
- tests: test temp dirs clean up after themselves, guard against regressions (#3285) ([#3291](https://github.com/8gi-foundation/8gent-code/pull/3291))
- tui: /model auto:free runs a free OpenRouter model, never a paid one ([#3292](https://github.com/8gi-foundation/8gent-code/pull/3292))
- permissions: read the anonymizer's owner identity from the running user ([#3283](https://github.com/8gi-foundation/8gent-code/pull/3283))
- tui: type the silent listener so CI type check passes ([#3288](https://github.com/8gi-foundation/8gent-code/pull/3288))

### Security
- system-one: a plain rm of files this session wrote in this project is allowed deterministically (#4159) ([#4160](https://github.com/8gi-foundation/8gent-code/pull/4160))
- permissions: resolve the HMAC key path from the env snapshot (#4132) ([#4134](https://github.com/8gi-foundation/8gent-code/pull/4134))
- security: secret scanner catches _KEY/_TOKEN names and common key shapes (#3203) ([#4018](https://github.com/8gi-foundation/8gent-code/pull/4018))
- security: shrink stale IntroBanner homedir baseline entry (#3394, partial) ([#3406](https://github.com/8gi-foundation/8gent-code/pull/3406))

### Fixed - Telegram resumes its daemon session on reconnect (#3538)
- When the Telegram link to the daemon drops and returns, `packages/telegram-bot/daemon-client.ts` and `packages/daemon/telegram-bridge.ts` resume the same session on both sockets instead of creating a new one (`packages/daemon/gateway.ts`).
- Cancel, Retry and New task destroy the old session first, so abandoned agents no longer pile up in the daemon. Context still does not survive a daemon restart.
- Tests in `packages/daemon/telegram-reconnect.test.ts` (against the real gateway) and `packages/telegram-bot/daemon-client.test.ts`.
### Fixed - the proxy cancels the model call when the client disconnects (#3541)
- `apps/proxy/src/server.ts` passes the client request's abort signal through `packages/providers/index.ts`, so a stop button or closed app aborts the in-flight request on the Ollama and compatible-API paths and the next request is not queued behind an abandoned generation. One hosted provider with its own client does not honour the signal yet.
- The per-request idle timeout is lifted only while a parsed chat request waits on the model and restored in a `finally`; the model step stays bounded by `EIGHT_TURN_TIMEOUT_MS`.
- Tests in `apps/proxy/src/cancel.test.ts` and `packages/providers/chat-signal.test.ts` (fake upstreams on 127.0.0.1).
### Fixed - a crashed MCP stdio server is restarted once, or dropped (#3542)
- When an MCP stdio server dies, the next call restarts it once (`packages/mcp/client.ts`, `packages/mcp/transport.ts`). If that fails, the server is removed from the tool list and status with one plain error, instead of showing as connected while the model calls a dead tool.
- Tests in `packages/mcp/dead-server.test.ts`, which also check that no spawned server process outlives close or drop.
### Fixed - PII placeholders split across stream chunks are restored (#3545)
- `createStreamDeanonymizer` in `packages/permissions/pii-anonymizer.ts` buffers a partial placeholder such as `[EMAIL_1]` across streamed chunks and restores the real value; `packages/eight/clients/deepseek.ts` uses it. Latent today (no streaming caller yet, provider off by default); the first streaming caller is safe by default.
- Tests in `packages/eight/clients/deepseek-stream.test.ts` (every two-way split, no network).
### Fixed - MCP tools reach the model with their real parameter list (#3546)
- `bridgeTools` in `packages/mcp/tool-bridge.ts` now hands each MCP tool's input schema to the model as the server declared it (`jsonSchema()` from `ai`), so enums, array item types and type lists such as `["integer", "null"]` are no longer dropped. A top-level `anyOf` / `oneOf` / `allOf` is flattened into one object by `normalizeMcpInputSchema`: branch properties are merged (first definition wins, any property name is kept), `allOf` keeps every branch's required fields, `anyOf` / `oneOf` keep only fields required in every branch. An either-or tool used to reach the server with an empty argument object; its argument now arrives. The server's schema object is not mutated.
- The permission gate, execute path, tool naming and result handling are unchanged. Arguments are no longer stripped against a local zod object, so the MCP server validates its own arguments.
- `EIGHT_MCP_LEGACY_SCHEMA=1` restores the previous converter for one release. Tests in `packages/mcp/tool-bridge.test.ts`.
### Fixed - the PII gate keeps tool-call ids, names and reply ids (#3547)
- `toOpenAIMessages`, `toAnthropicMessages` and `toOllamaMessages` in `packages/providers/index.ts`, and `apps/proxy/src/openai.ts`, carry earlier tool calls and their reply ids through the PII gate, so step two of a multi-step tool loop no longer fails with a provider 400 or loses its tool_result structure.
- Tests in `packages/providers/__tests__/tool-history-wire.test.ts` and `apps/proxy/src/proxy.test.ts`.
### Fixed - the model picker hides Ollama models that cannot chat (#3548)
- `filterChatCapable` in `apps/tui/src/lib/model-selection.ts` asks Ollama's `/api/show` for capabilities (2 s timeout, cached) and hides models without `completion`, keeping the name filter as fallback. A filtered model is reported as unable to chat rather than not installed.
- Startup detection (`detectBestLocalProvider`) still ranks by name and corrects itself one tick later. Tests in `apps/tui/src/lib/model-selection.test.ts` (injected fetch).
### Added (off by default) - pre-completion verify gate (#3550)
- With `EIGHT_VERIFY_GATE=1`, a turn that wrote files and ran no read or test afterwards gets one verify nudge before it finishes, on both the native path (`packages/eight/agent.ts`) and the text-tool path (`packages/ai/text-tool-loop.ts`). Logic in `packages/eight/verify-gate.ts`. Off by default; turning it on needs a benchmark:v2 off vs on comparison first.
- Tests in `packages/eight/verify-gate.test.ts`, `packages/eight/verify-gate-agent.test.ts` and `packages/ai/text-tool-loop.test.ts`.
### Added (off by default) - tool-output injection filter (#3551)
- New `packages/permissions/output-filter.ts`. With `EIGHT_OUTPUT_FILTER=1` exactly, the output of `web_fetch`, `web_search` and `mcp_call_tool` is shown to a judge model on this machine before the main model reads it. The judge answers YES or NO and quotes any embedded instruction; the quoted text is cut out and replaced with `[output-filter: removed an embedded instruction]`. If the judge flags text it cannot locate, the output is kept with a notice line in front telling the model to treat instructions in it as data. Long output is judged in 12,000-character chunks. The idea is the detect-then-remove defence from the PromptArmor paper (arXiv 2507.15219); prompt and code are our own.
- Hooked once in `ToolExecutor.execute` (`packages/eight/tools.ts`), after the secret scrub and before the ArtifactStore, so the native and text-tool paths both get it and no secret reaches the judge. Any other flag value, including unset, `""`, `"0"`, `"true"` and `" 1"`, returns the text unchanged and calls no judge. Other tools, `read_file` included (already confined to the working directory), are never judged.
- The judge is an Ollama-compatible `/api/chat` endpoint at `EIGHT_OUTPUT_FILTER_HOST`, else `OLLAMA_HOST`, else `http://127.0.0.1:11434`, and must be loopback; any other host is refused. Model `EIGHT_OUTPUT_FILTER_MODEL` (default `qwen3:32b`, since the paper needed a model of about that size for near-zero error rates), timeout `EIGHT_OUTPUT_FILTER_TIMEOUT_MS` (default 30000). The request does not follow redirects; a redirect counts as a judge failure. It fails open: a judge that errors, times out or is refused leaves the output unchanged and logs a warning. When only some chunks fail, removals from the chunks that were judged are kept and a notice line says part of the output was not checked. At most 8 chunks (96,000 characters) are judged per result; the rest passes through behind the same notice. A judge quote shorter than 8 characters (whitespace collapsed) is never cut, and the line-level fallback only cuts a single line containing the quote or a run of whole consecutive lines equal to it; anything else is kept behind the flagged notice.
- Tests in `packages/permissions/output-filter.test.ts` (deterministic fake judge, plus a fake Ollama served on 127.0.0.1) and `packages/eight/tools-output-filter.test.ts` (the executor hook, flag off and on). The planted text is a benign marker line. False-alarm rate on our own tool traffic and added latency per call are not measured yet; they decide whether this goes further.
### Added (off by default) - the daemon resumes an interrupted task after a crash or power cut (#3552)
- With `EIGHT_RESUME_ON_BOOT=1`, `packages/daemon/session-journal.ts` brings a session back on boot with its history from the last checkpoint, wired through `packages/daemon/agent-pool.ts` and `packages/daemon/index.ts`. The old checkpoint is kept until the restore succeeds. Meant for a single-user machine.
- Tests in `packages/daemon/session-journal.test.ts`.
### Added (opt-in, off by default) - stream idle gap for local text-tool steps (#3553)
- `EIGHT_STREAM_IDLE_MS` streams the local text-tool reply and aborts a step only after that many ms with no output, so a slow model that keeps writing is no longer cut off at 5 minutes; with it on the per-step ceiling defaults to 20 minutes unless `EIGHT_TURN_TIMEOUT_MS` is set. Unset, behaviour is unchanged. Documented in `docs/VESSEL-ABILITIES.md`; tests in `packages/ai/stream-idle.test.ts`.
### Added (off by default) - provider allowlist that fails closed (#3555)
- With `EIGHT_PROVIDERS_ALLOW` set (for example `ollama,8gent`), failover in `packages/providers/failover.ts` can no longer fall through to a provider outside the list; it throws a typed error instead of a silent cloud hop. Malformed failover chains are discarded fail-closed.
- Tests in `packages/providers/failover-allowlist.test.ts`.
### Added (off by default) - autoresearch keeps only prompt rules that win without hurting held-out (#3556)
- With `AUTORESEARCH_GATE=1`, `benchmarks/autoresearch/mutation-gate.ts` splits tasks into tuning and held-out sets, and a batch of new prompt rules is kept only if tuning improves and the held-out mean does not drop. Rules restored from earlier runs that came from held-out tasks are removed, and a failed rerun scores 0.
- Gated runs rewrite `benchmarks/autoresearch/loop-state.json` with the pruned rule list. An answer-key rule for a tuning id can still be kept. Tests in `benchmarks/autoresearch/mutation-gate.test.ts`.
### Added - resumable, seeded benchmark runs (#3557)
- `benchmarks/runner.ts --resume` continues an interrupted run from the last finished item instead of redoing it, records the seed (`--seed`), and labels resumed runs in reports. Per-item results are written by `benchmarks/run-store.ts`.
- Tests in `benchmarks/run-store.test.ts`, including an end-to-end subprocess run against a local stub.
### Added (off by default) - MCP 2026-07-28 protocol with the old handshake as fallback (#3549)
- With `EIGHT_MCP_MODERN=1`, the MCP client (`packages/mcp/client.ts`, `packages/mcp/transport.ts`) reaches modern-only servers over stdio and HTTP and falls back to the legacy handshake, and the 8gent MCP server (`packages/mcp/server.ts`) answers both eras. Default behaviour is unchanged.
- Tests in `packages/mcp/era.test.ts` and `packages/mcp/server-era.test.ts`; the flag-off tests pin current behaviour.
### Added (trial, off by default) - busy sessions queue messages instead of refusing them (#3554)
- Today a message sent to a daemon session while it is still answering the previous one is refused with `[error] agent is busy`, so in a burst of 20 messages 19 are dropped. With `EIGHT_SESSION_QUEUE=1` (exactly `1`), `AgentPool.chat()` in `packages/daemon/agent-pool.ts` puts it in a per-session first-in, first-out line instead: messages run one at a time, in the order they arrived. When a turn finishes, the session is handed straight to the next waiting message, so a new arrival cannot jump the line.
- `EIGHT_SESSION_QUEUE_MAX` caps how many messages may wait per session, not counting the one running. Default 32: unset, or a value that is not a non-negative integer (`abc`, `-1`, `2.5`), means 32, and `0` means no waiting line at all (every message to a busy session is refused as full). A message arriving when the line is full gets `[error] session queue full` and an `agent:error` event with `session queue full`. When a session is destroyed, every waiting message is dropped and gets `[error] session ended`; none of them runs.
- With the flag unset or any other value, the busy refusal is unchanged: the same `[error] agent is busy` string and the same `agent:error` event. The dispatch rate limiter (`packages/daemon/dispatch.ts`, a per-caller rate limit) is a different refusal and is not changed. Tests in `packages/daemon/agent-pool-queue.test.ts`: a burst of 20 with the flag off still gets 19 refusals; with it on, 0 refusals, arrival order kept, never more than one turn in flight; a full line errors; an invalid max means 32 and `0` means none; destroying the session drops the waiters. Not measured yet: no burst has been run against a live daemon on a real model.

### Added (opt-in) - action-first communication style (#3487)
- New `communicationStyle` value `action-first`, choice 6 in the onboarding communication step (`packages/self-autonomy/onboarding.ts`), also accepted by name. When picked, `USER_CONTEXT_SEGMENT` in `packages/eight/prompts/system-prompt.ts` adds `ACTION_FIRST_STYLE`: open with the action or answer, numbered steps, lists capped at five, commands in code blocks, plain failure statements, minutes for estimates, no recap or sign-off, and one closing "Next:" line. It opens with a precedence line saying these rules win over the base prompt's joke `COMPLETED` summary (`packages/eight/prompt.ts`) and the greeting and completion phrases in the personality block (`packages/eight/agent.ts`); a required completion marker becomes one plain line just before "Next:". Written in our own words; nothing on screen names a condition.
- Nothing changes unless a user picks it. The other five styles and the no-style prompt are byte-identical to before, and an unknown answer still falls back to `sarcastic`. Tests in `packages/eight/prompts/action-first-style.test.ts`, with the before lines checked against the previous `system-prompt.ts`. Whether replies actually follow the shape (checker pass rate on replayed cases, style on versus off) is not measured yet.
- Communication styles now reach local models too. The compact system prompt used on the text-tool path (`ollama`, `8gent`, `lmstudio`, `llama-server`) dropped the whole user-context block, so every style, the user's name, role and non-English language, and the board briefing never reached a local model. `packages/eight/agent.ts` now appends that block after the project instructions, so the cached prefix before it is unchanged (#3222). The board briefing part goes only to a model on this machine (the #3236 `runsOnBox` rule), judged on the endpoint the request actually uses: the session `baseUrl` when set, otherwise `OLLAMA_BASE_URL` / `OLLAMA_HOST` for `ollama` and `LLAMA_SERVER_URL` for `llama-server`. A local runtime pointed at another host gets the user context without the board briefing. When the session's runtime is local, the same check is also made per request: when a turn is rerouted to another local provider (a model-not-found reroute or the tool-capability switch) and that provider's endpoint is off this machine, that request is sent with the user context but without the board briefing and the user-global files. Test in `packages/eight/reroute-off-box.test.ts`. The #3236 check for the operator's user-global instruction files now uses the same endpoint, so they no longer reach an `ollama` or `llama-server` host named only by those env vars. Users with no completed onboarding and no name get the same prompt as before. Test in `packages/eight/user-context-local-prompt.test.ts`.
- On the local text-tool path the chosen style is also restated as the last message of every model request, so a long tool loop cannot bury it. Only styles with a guide line get it: `concise`, `detailed`, `casual`, `formal` and `action-first`. `sarcastic`, the default and the fallback for an unrecognised onboarding answer, has no guide line (its prompt line is just the name), so it gets no reminder; neither does no style. The reminder is resent and reprocessed by the model on every round of the tool loop: about 1 KB for `action-first`, one short line for the others. It reuses the same "Communication style" line (`communicationStyleLine` in `packages/eight/prompts/system-prompt.ts`) and is sent as a harness note, not a second system message: Ollama's qwen3.8 renderer takes one system turn and the raw path folds every system message into it, which would move the cached prefix (#3222). It is never stored in the history. Table officers get none. Test in `packages/eight/style-reminder-local.test.ts`.
- Only the six fixed style keys are stored or prompted. A style outside the set is dropped when `user.json` is loaded, rejected by `8gent preferences set style` (exit 1, with the allowed list), and not taken from a cloud preferences pull; `communicationStyleLine` and `composeSoulPrompt` also emit nothing for it, so no style line and no reminder. The user's `language` reaches the prompt only when it is a language code (`en`, `pt-BR`, `zh-Hant`). The board briefing path now resolves through `resolveHome()` like other home paths (#3240). New `packages/self-autonomy/communication-style.ts` holds the set and both checks. Tests in `packages/self-autonomy/communication-style.test.ts` and `packages/eight/user-context-guards.test.ts`. Whether it changes reply shape on a local model is not measured yet.

### Added (trial, off by default) - effort by task kind (#3461)
- New `packages/providers/effort-policy.ts` maps the existing `TaskCategory` from `packages/ai/task-router.ts` to a requested thinking level: `simple` to `low`, `code` to `medium`, `reasoning` to `high`, plus a `review` kind outside `TaskCategory` mapped to `high` (the task router has no review or security label). `creative`, an unknown kind or no kind leaves the provider default. `ChatRequest` gains an optional `taskKind`, read only by the policy and never sent to a provider.
- `ProviderManager.chat()` in `packages/providers/index.ts` applies it at one point, before the existing thinking resolution, and only when `EIGHT_EFFORT_POLICY` is exactly `1` and the caller left `thinking` empty. An explicit `thinking` always wins, and the level still downgrades or drops through `resolveThinkingLevel` for the active provider (today only `openai` and `anthropic` accept a level). Any other flag value, including unset, `""`, `"0"`, `"true"` and `" 1"`, returns the caller's request object unchanged.
- Fixed a pre-existing Anthropic extended-thinking mismatch in `chatAnthropic` (`packages/providers/index.ts`): the thinking budgets are 1024 / 4096 / 12288 / 32768 tokens but `max_tokens` defaulted to 4096, and the API rejects `budget_tokens` at or above `max_tokens`, so any Anthropic call with `thinking` at low or above would fail with a 400. When thinking is set, a `max_tokens` cap (caller value, or the 4096 default) is raised to the budget plus 4096 only when it is at or below the thinking budget; a cap already above the budget is kept as is. Calls without thinking send the same `max_tokens` as before.
- First caller: `8gent --cli --task-kind <simple|code|reasoning|review>` (`packages/eight/cli.ts`) passes the kind straight to `manager.chat()`. The accepted kinds are derived from the policy table, and `ChatRequest.taskKind` is typed to the same set. Any other value exits 1 with an error before a model is called (repeated `--task-kind`: the last one wins); without the option the request is the same as before. `--json` output now also carries `usage` (prompt, completion and total tokens) and `thinking` (requested and applied level) when the provider returns them; both keys are absent otherwise, so the default output is unchanged. The quick-answer lane is untouched. Tests in `packages/providers/effort-policy.test.ts` (OpenAI, Anthropic and Ollama payloads, Anthropic `max_tokens` above the budget) and `packages/eight/cli.test.ts`. The A/B on real tasks (tokens and pass rate, flag on versus off) is not done; it decides whether this goes further.
### Added (trial, off by default) - routine blueprints: named templates with typed blanks (#3463)
- `packages/cron/blueprints.ts` holds three blueprints (`morning-brief`, `pr-watch`, `weekly-review`) with typed slots: a 24-hour `HH:MM` time, weekdays (`mon`..`sun`, `weekly-review` takes exactly one), a choice from a fixed list, and length-capped text. `fillBlueprint(name, slots)` refuses a bad value with a message naming the slot, and returns the same options object `RoutineManager.create()` already takes, so there is no second scheduler. `createFromBlueprint(mgr, name, slots)` is the only creation path and refuses unless `EIGHT_BLUEPRINTS=1` exactly.
- The cron string is built only from the validated time, weekday and choice values. Text reaches the prompt only, fenced in a `<note>` or `<repo>` tag with a line saying the tagged text is the user's value, not an instruction. It may not start with `-`, allows letters in any script, marks, digits, spaces and basic punctuation, and refuses control characters, invisible (default-ignorable) characters, runs of 4 or more combining marks, `$`, backtick, `;`, `|`, `&`, `<` and `>`, so a value cannot close its fence. The `pr-watch` repo must be `owner/name` (owner of letters, digits and `-`, not starting with `-`; a name not made only of dots). Unknown names are echoed JSON-escaped in errors. Every built schedule is checked against a five-field digits-and-`*,/` pattern before it is returned.
- One surface, `8gent blueprint list | add <name> key=value...`, in `bin/8gent.ts`. With `EIGHT_BLUEPRINTS` unset or anything other than `1` it prints that blueprints are off, exits non-zero and writes nothing. `add` saves a routine to `~/.8gent/routines.json` and says so; it refuses a slot given twice, `__proto__` as a slot name, and a bare word, echoing the input JSON-escaped. Nothing runs routines yet (the `cron` commands and the daemon use other schedulers, and nothing calls `RoutineManager.tick()`), so this trial only saves them; there is no run command.
- Tests in `packages/cron/blueprints.test.ts` (catalog, validator, and a text slot staying one argv element in `RoutineManager`'s runner with spawn replaced) and `packages/cron/blueprint-cli.test.ts` (the CLI with a temp `HOME`: flag off writes nothing, flag on saves one routine, a bad slot exits non-zero, `run` is not a subcommand). No test starts an agent or a model.
### Added (flag off) - decision-readout judge reads a probability from a local llama.cpp server (refs #3455)
- `packages/providers/decision-readout.ts` asks a user-run llama-server one typed yes/no question on `/v1/systemone` (llama.cpp PR 29818) and passes only when the returned probability is at or above a threshold (default 0.9). `SeleneJudge.judge` in `packages/providers/local-judge.ts` routes to it only when `EIGHT_DECISION_JUDGE=1`; with the flag unset, behaviour is unchanged. `EIGHT_DECISION_JUDGE_URL` (default `http://127.0.0.1:8080`) must be loopback, and `EIGHT_DECISION_JUDGE_THRESHOLD` sets the bar.
- Fail closed: a non-loopback URL, an unreachable server, a timeout (10 s), an HTTP error, a body over 64 KiB, malformed JSON, or a probability that is not a finite number in 0 to 1 all return FAIL. With the flag on, `SeleneJudge.isAvailable` probes `GET /health` on the decision server instead of Ollama, so the kernel's local-first gate cannot silently route the trial to the cloud judge. `JudgeVerdict` gains an optional `probability`. A threshold outside 0.5 to 1 falls back to 0.9. 58 tests in `decision-readout.test.ts` run against a fake server on 127.0.0.1. Do not enable the flag where the kernel scorer or training loop runs until the replay passes; flag-on verdicts are still recorded as judgeSource "local", the same as Selene's. Accuracy on our questions is unmeasured; no model has been downloaded or run.
### Added (trial, off by default) - speed-change gate: a faster model setting is accepted only if its answers hold (#3467)
- `benchmarks/autoresearch/speed-gate.ts` runs a baseline and a candidate model config paired on the same fixed suite (JSONL of `{"prompt"}`, read with the canary traffic loader). It makes one untimed warm-up call per side, then calls the sides one at a time with the order alternated per input, and records each side's decision, probability and latency. It writes a JSON report and exits ACCEPT (0), REJECT (1) or NO WIN (2). ACCEPT needs p50 latency to improve by at least `--min-improvement` percent, every decision to match, and max probability drift within `--max-drift`. Any changed decision, drift over tolerance, a probability present on only one side (reported as `maxDriftUnmeasurable: true`), a failed, timed-out or null call, or a NaN or negative timing is REJECT. An improvement below `--materiality` or below the declared margin is NO WIN. All thresholds and `--timeout-ms` must be passed, and the suite must exist and hold prompts; otherwise it is a usage error (exit 4) and nothing runs.
- Decisions are made deterministic by the gate's own caller, not the shared `callModel`: it posts to `{url}/api/chat` with `format: "json"`, `temperature: 0` and a fixed seed (`--seed`, default 8, written to the report), under a fixed system prompt asking for `{"decision": <one short label>, "probability": <0..1>}`. Replies are parsed defensively (code fences, whitespace and trailing punctuation are stripped; nothing in a reply is acted on). Suite prompts must name a fixed label set (for example "Answer yes or no."), or free-text decisions will differ and REJECT.
- Safety: a target `url` must be an http or https origin with no credentials, query, fragment or path; requests go to that origin plus `/api/chat` with redirects refused. Only loopback hosts (127.0.0.0/8, ::1, localhost) are allowed by default; any other host needs `--allow-remote`, which prints the host it allows. Link-local hosts (169.254.0.0/16, fe80::/10), the AWS IPv6 metadata range (fd00:ec2::/32) and any IPv6 host that embeds an IPv4 address (mapped, compatible, translated, or NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, for example `[::ffff:169.254.169.254]`) are always refused, unless the embedded address is 127/8. 6to4 (`2002::/16`) is not covered. Hostnames are not resolved, so under `--allow-remote` a name pointing at an internal address is not blocked; the stderr line says so. A reply body over 64 KiB, an empty, missing or non-string decision, or a decision over 64 characters is a failed call. The suite must be a regular file of at most 1 MiB and 1000 prompts with every line valid; anything else is a usage error. `--out` must not be a symlink, a directory or an input file, and the report is written 0600 through a temp file and a rename. When no input carries a probability, the report says `driftChecked: false` and warns. A crash or I/O error, including a failed report write after the verdict is printed, exits 5, never a verdict code.
- Off unless `EIGHT_SPEED_GATE=1`; otherwise it prints that it is off and exits 3 without calling anything. Run: `EIGHT_SPEED_GATE=1 bun benchmarks/autoresearch/speed-gate.ts --baseline base.json --candidate cand.json --suite suite.jsonl --min-improvement 5 --materiality 0.6 --max-drift 0.05 --timeout-ms 60000 --out report.json`, where each config is `{"url","model","label"}`.
- Scope: only `/api/chat` endpoints (Ollama and the 8gent provider) are served. Marlin (JSON-RPC over stdio) and moshi-mlx (websocket) need their own callers and are not covered. The probability is the model's self-report, not a scorer probability read from logits as in the study that suggested this gate. One timed sample per input; the report gives per-side sample counts and warns when the suite has fewer than 20 inputs. If the two models do not both fit in memory, alternating them measures load time, not inference; set Ollama `keep_alive` or check both are resident (`ollama ps`) before trusting a p50.
- Not measured yet: no speedup has been gated on a real model; the tests use a fake caller, fake clock and fake fetch only. It does not repeat runs to estimate noise or change any model setting. Concept from a public latency study; no code was copied. Tests in `benchmarks/autoresearch/speed-gate.test.ts`.

### Fixed - stdio MCP servers can connect again (#3479, found under #3474)
- `packages/mcp/transport.ts` called `getWriter()` on Bun's spawn stdin, which is a FileSink, not a WritableStream, so every request threw and no stdio MCP server could ever connect. It now writes to the sink and flushes. Regression test: `packages/mcp/transport.test.ts` (fails on the old code, passes on the fix).
- Hardened in the same transport (8SO review of #3474): a stdio server now inherits only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*` and `TMPDIR` from this process, plus the `env` its own config entry names; API keys and tokens in the parent environment no longer reach it (tested with a sentinel `OPENROUTER_API_KEY`). Output is split on newlines scanning each chunk once, and a single message over 16 MB (`MAX_MESSAGE_CHARS`) closes the transport, kills the server and fails every pending request (tested with a 40 MB flood). When the server's output ends, pending and later requests fail at once instead of waiting out the 30 s timeout, and a rejected `flush()` is caught.

### Added (behind a flag, text-tool path only) - local MCP goes from unreachable to reachable, and lean (#3474)
- Before this, a local model's turn could not use MCP at all: nothing in the runtime called `MCPClient.connect()`, the stdio transport could not write (entry above), and the text-tool path (ToolExecutor: ollama, lmstudio, llama-server) never offered the MCP tools. With `EIGHT_MCP_LEAN=1` (exactly `1`), the ToolExecutor offers `mcp_list_tools` and `mcp_call_tool`, connects the configured servers on first use (never at startup; one retry if none came up), and serves them lean through `packages/mcp/lean.ts`. Unset, empty, `0`, `true`, ` 1` and any other value leave the MCP tools as they were: same tool definitions, same `mcp_list_tools` and `mcp_call_tool` answers (tested). Not behind the flag, so they apply with it off too: the default policy rules on `.8gent/mcp.json` and `.8gent/policies.yaml` and the `resolved_path` matching for `write_file` and `delete_file` (below); `mcp.json` resolved under `EIGHT_HOME` through `resolveHome()`; a server that fails the handshake is closed (`MCPClient.connect`); the per-call MCP approval card in the TUI now shows the call and its arguments, or refuses (below); without the TUI, the per-call MCP terminal prompt shows the sanitised call and defaults to No (`[y/N]`, a bare Enter declines); the AI SDK and REPL MCP listings replace control and bidi characters.
- Lean means: `mcp_list_tools {query}` returns the 8 best word matches, one line each; `{tool, server}` returns that one tool's full input schema; no arguments lists servers and counts. `mcp_call_tool {fields: ["totals.net"]}` keeps only those dotted paths of a JSON answer (own keys only; `__proto__`, `prototype` and `constructor` refused; a missing path reports the top-level keys). An answer over 4000 characters is written to a 0600 file named by the harness (O_EXCL, O_NOFOLLOW) in a per-session 0700 dir under `<data dir>/tool-results/`, and the model gets the path plus a 400-character preview.
- Secrets: the executor's secret scrubber runs on the answer before projection, and again on the projected text, all before spill or preview, so the #2464 order (scrub before anything is persisted) holds. The second pass exists because projection re-encodes JSON: a key the server spelled with a `\u0041` escape reaches the scanner only after projection decodes it (tested for `\u`- and `\/`-escaped secrets in a spilled projection; with today's scanner rules the `\/` form is already caught by the first pass, the `\u` form only by the second). What the scrubber guarantees is what the scanner recognises: an escaped secret in an answer called without `fields` is written as it arrived, escaped, in the file and in the answer.
- Starting servers needs the person's yes, once per session. The first lean `mcp_list_tools` or `mcp_call_tool` reads `<home>/.8gent/mcp.json` once and shows an approval card through the existing MCP approval path (`askMcpStartApproval` in `packages/permissions/mcp-gate.ts`) naming every server with its command and args (an arg holding a space or quote is quoted) and the NAMES of the env variables its config sets, or its URL without credentials or query; env values and headers never appear, and the working directory the servers start in is on the card. In the TUI the card shows every line in full, wrapped. The TUI decides the fit, not the gate: after Ink lays the card out (display width, so CJK and emoji count double), if the card's own box is not inside every box around it and the screen, it is taken down and the request refused ("does not fit on this screen"), nothing asked and nothing started. It re-checks at render (a resize included; the card's hook listens for resize itself) and again at key time, so a card pushed out of view by something growing above it, or hidden by a `display: none` box (a 0-sized card counts as not shown), is refused by the next key, never answered by it. The card takes a key only once it has been laid out whole at the current terminal size and no key has come for 500 ms: any key before that, chat text included, restarts the wait, and a card key in it is swallowed, so "okay" typed as the card appears does not approve it. Without the TUI, the terminal prompt shows the same sanitised text and defaults to No: bare Enter declines. While the flag is a trial, a server's config env may only set credential names: upper case, ending `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` or `_ID`. Any other name is refused before the card and nothing starts, because a variable can change what program runs or what code loads and the card would not show what really runs. This is an allowlist: the denylist of rounds 1 and 2 (`PATH`, `NODE_OPTIONS`, `LD_*` ...) kept missing names such as `JAVA_TOOL_OPTIONS`, `HOME`, `PIP_INDEX_URL`, `SHELLOPTS` with `PS4`, and `NODE_TLS_REJECT_UNAUTHORIZED`. Plain settings such as `AWS_REGION` or `LOG_LEVEL` are refused too, for now (tested: a `PATH` override, `NODE_OPTIONS=--require`, `JAVA_TOOL_OPTIONS`, `HOME`, and every name 8SO probed). Approved, exactly that list starts, with no re-read in between; denied, nothing starts and the answer stands for the session; every such refusal says to restart the session to be asked again. Infinite starts without a card; with no card and no terminal the answer is no. The card is separate from the per-call card (#3230), so approving one call to server A never starts B. Parallel first calls share one card and one start, a server that fails the handshake is closed rather than left running, and started servers are closed on process exit. Listing is ungated and allowed in Plan mode, so in Plan mode the lean listing does not start servers; `mcp_call_tool` is refused in Plan mode before anything starts (tested through the executor).
- `mcp.json` is resolved through `resolveHome()`, so `EIGHT_HOME` decides which servers can start. New default policies ask before an agent writes or deletes `.8gent/mcp.json` or `.8gent/policies.yaml`; in the text executor, as with the other `require_approval` rules on those actions, that means the call is refused. The `write_file` and `delete_file` rules match the path as typed and `resolved_path`, a new field the policy engine sets for those two actions: the path resolved against the executor's working directory, `~/` expanded, symlinks followed (`resolvePolicyPath` in `packages/permissions/policy-engine.ts`), so `./`, `//`, `a/../` and a relative `mcp.json` from inside `~/.8gent` are caught too. A shell redirect's target is checked the same way, against the executor's working directory (the bash segment gate now passes it through `evaluateCapabilities`), so `echo {} > mcp.json` run from inside `~/.8gent` asks. The `run_command` rule is a literal-string match only: it catches any command that spells either path out, including read-only ones such as `cat ~/.8gent/mcp.json`, not one that builds it (`cd ~/.8gent && ... > mcp.json`, `"$HOME/.8gent/"mcp.json`, `mcp?json`). It is a speed bump, not a boundary.
- The per-call MCP card in the TUI (`askMcpApproval`) used to show only its title, "MCP tool call". It now shows `mcp_call_tool <server>/<tool> <arguments as JSON>` on one line, control and bidi characters replaced, wrapped in full; a call the TUI cannot show whole in the chat column is refused with nothing sent, by the same check as the start card.
- Server text is capped before any regex, parsed inside try, never picks a file name, and has control and bidi characters replaced before it is echoed, answers under the 4000-character cap included (CRLF becomes LF). Concept from Uber's "Designing MCP Gateway"; no code taken.
- Measured through the ToolExecutor against a fake 41-tool stdio server (`packages/eight/tools-mcp-lean.test.ts`), characters entering context. Today (flag off) the numbers are moot: nothing connects, so every MCP call returns "No MCP tools available" or "not connected". The comparison is therefore naive wiring (flag off, client connected by hand in the test) against lean wiring, with spill and chip paths left out of the counts because their length depends on where HOME is: listing 10,417 vs 208 (plus 299 for the one schema fetched); a 20 KB answer 20,050 vs 625, or 26 with `fields`; a 50 KB answer 1,115 (the existing ArtifactStore chip, #2463, already replaces results over 50,000 bytes) vs 625.
- Not covered: the native AI SDK tools in `packages/ai/tools.ts` (cloud providers), the bridged per-tool ToolSet (`client.getTools()`) and the REPL `/mcp-tools`. None of them connects a server, so on their own they still reach no MCP tool; once the lean path has connected in a process they see its servers in full, untrimmed. The AI SDK `mcp_list_tools` and the REPL `/mcp-tools` now replace control and bidi characters in server names and descriptions and flatten descriptions to one line. Follow-ups: the spill dir has no disk budget and no sweep of earlier sessions' dirs (a 7-day sweep was cut from this change to keep it small), and spill dirs are keyed per process, not per agent session. The result store (`storeResult`) is tool-agnostic so #3477 can reuse it; until #3477 picks one, it and the older ArtifactStore (#2463: 0644 files under a pid-named dir) are two stores.

### Fixed - the launch splash marker and the voice cache follow the resolved home directory (refs #3394)
- `apps/tui/src/lib/intro-gate.ts` (`readSeenVersion`, `markIntroSeen`) and `packages/voice/voice-resolver.ts` (`listInstalledSystemVoices`) now default to `resolveHome()` from `packages/core/home.ts` instead of calling `os.homedir()`, so `EIGHT_HOME` redirects `~/.8gent/intro-seen` and `~/.8gent/cache/system-voices.json` like the other migrated paths. The voice cache path is resolved on each call rather than once at module load, so a home set after import is honoured. Behaviour is unchanged when `EIGHT_HOME` is not set.
- Both files drop out of the home-resolver ratchet's "outside the baseline" list in `tests/security`. No committed test drives the default-home path; it was checked by hand with `EIGHT_HOME` set after import. Coverage is indirect: `intro-gate.test.ts` and `voice-resolver.test.ts` exercise the same functions with an explicit home or cache path, `packages/core/home.test.ts` pins `resolveHome()` precedence, and the ratchet pins that neither file calls `homedir()`.
### Fixed - refused commands no longer use up the 50-call tool budget, and a stopped turn says it stopped (refs #3409)
- Pilot l5-feature-e2e (runs 2026-10-03_191633 and 194741) wrote the feature and tests but never committed: the 50-call circuit breaker counted `run_command` calls the shell sanitizer had refused for `&&` or `;` chaining, which never ran. Both runs hit 51 calls and stopped one call before the commit, and the half-written last sentence came back as if it were the answer.
- A call now counts as refused only when the shell sanitizer rejects its command string, decided from the call's input before it runs, never from tool output, so output that prints "[BLOCKED]" still counts. Every other refusal, and `mcp_call_tool`, still counts as an executed call.
- Refused calls still count for the repeat and ping-pong checks, and have their own cap of 100 per turn. Worst case per turn: 51 executed plus 100 refused, or 50 plus 101.
- When the breaker stops a text-path turn, the reply ends with a plain note, for example "[harness] Stopped early, the task is not finished: I reached the limit of 50 tool calls in one turn. Continue from here?" The native path does not show the note yet (#3412).
- Tests in `packages/eight/breaker-refusals.test.ts`.

### Fixed (partial) - the home-resolver ratchet baseline shrinks for IntroBanner (#3394)
- `apps/tui/src/components/IntroBanner.tsx` now makes 2 direct `homedir()` calls, not 3, since the intro redesign moved the seen-version reads into `apps/tui/src/lib/intro-gate.ts`. Its entry in `tests/security/fixtures/homedir-baseline.ts` drops from 3 to 2, which clears the stale-entry failure. The baseline only shrinks here; no entry is added and no assertion changes.
- #3394 stays open. Two ratchet failures remain: six runtime files outside the baseline now call `homedir()` (`apps/tui/src/lib/intro-gate.ts`, `packages/decide/rules.ts`, `packages/permissions/owner-identity.ts`, `packages/voice/voice-resolver.ts`, `scripts/build-finalize.js`, `scripts/pack-smoke.ts`) and `bin/8gent.ts` grew from 2 to 3. 8SO has reviewed all seven and ruled on each; the changes land in follow-up PRs under #3394. The two grader isolation failures reproduce only when `bun` is not on `PATH`; with it on `PATH` they pass. They also stay open under #3394 until CI runs the security suite with `bun` on `PATH`.

### Fixed (partial, TUI only) - in the TUI, a missing default model is swapped before the first turn, not missed on every turn (#3332)
- The `8gent` provider is the configured Ollama, but the TUI took its model list from the registry, which declares `eight-1.0-q3:14b`. That model is not installed on most machines, so a session on `8gent` kept it, and every turn asked Ollama for it (a 404 in about 10 ms), then, because no failover chain is keyed on that id, sent the same id to OpenRouter, which does not serve it, and ended in "All providers exhausted". The TUI now lists what Ollama has installed for `8gent` as it already did for `ollama`, so the existing model check replaces a missing model once, before any turn, and says so in one line: "eight-1.0-q3:14b is not installed in Ollama, so this session uses <model>. Pick another with /model." An explicit `--model` is still never replaced (#3084). Tests in `apps/tui/src/lib/model-selection.test.ts`. #3332 stays open for the registry default (`packages/providers/index.ts`), `8gent run --provider 8gent` without `--model` (`packages/eight/run.ts:246`), `packages/eight/index.ts`, `packages/daemon/goal-rpc.ts`, `packages/orchestration/role-config.ts:71`, the failover chain entry at `packages/providers/failover.ts:139`, `8gent doctor` reporting the resolved default, the CLAUDE.md provider line, and a test for `EIGHT_MODEL`.
### Added - the agent runs the test suite before it commits, and refuses a red one (#3402)
- Pilot run 2026-10-03_180159 (l5-feature-e2e, main ed3ab9fd) scored 18/19: the agent wrote `test/cli.test.ts` using Bun's `$` without importing it, ran `bun test`, got exit 1, staged and committed anyway. `git_commit`, and a `git commit` through `run_command` (also with leading `NAME=value` assignments, an `env` or `command` prefix, a full path to git, or git options before `commit`), now go through `packages/eight/commit-gate.ts` first. In a repo whose `package.json` has a test script, the suite runs (`bun run test` with a bun lockfile or a `bun` script, else `pnpm test`, `yarn test` or `npm test`) through the agent's own gated `run_command`. A red suite, including one killed by a signal, is returned as the tool result, starting `[COMMIT BLOCKED] Not committed:` with the first failing line and the end of the output, and nothing is committed. The marker counts as a failed call in the honesty ledger, so the reply cannot claim the commit.
- No test script, npm's "no test specified" stub, a clean tree, or only docs changed (`.md` or `.mdx` files, `LICENSE`, `NOTICE`): commit as before. A `.txt` file or code under `docs/` still runs the suite. The changed and untracked files are hashed by path and content, so a tree unchanged since a green run this session commits without running the suite again; staging does not count as a change. A red result on an unchanged tree is reused, not rerun, and after two refusals on the same tree the commit goes through marked `[COMMIT GATE] Committed with ... still failing`, so a suite that was already red cannot trap the agent. The same rule also lets an agent that retries without changing anything commit a suite its own work turned red; that commit carries the same failing marker. A suite that does not finish in `EIGHT_COMMIT_GATE_TIMEOUT_SEC` (default 120, at most 300), a runner that cannot start (exit 126 or 127 with a "not found" or "cannot execute" line: no `bun`, `yarn` or `pnpm` on PATH, or a script calling a missing binary), a run a permission gate stops, output the gate does not recognise as a clean run does not block: the commit is made and says it is not verified. An exit 126 or 127 without such a line is red. A commit aimed anywhere (`git -C`, `--work-tree`, `--git-dir`, `GIT_DIR=`, `GIT_WORK_TREE=`) is checked against this repository's suite, exactly like a plain `git commit`; the gate does not try to work out which repository git will commit to. When the suite passes but tracked files have unstaged changes, the commit says that what it holds is not verified, since the suite ran on the working tree. Output is scrubbed for secrets before it is shortened. `EIGHT_COMMIT_GATE=0` turns the gate off.
- Coverage: only agents on the text-tool path (`ToolExecutor`) are gated. That is the `ollama`, `lmstudio` (LM Studio) and `llama-server` providers, any provider with `EIGHT_TEXT_TOOLS=1`, and agents spawned with an edit scope. The default `8gent` provider (local `eight-1.0`) and every API provider (OpenRouter, including the free failover tier, and the rest) use the native AI SDK `git_commit` and `run_command` in `packages/ai/tools.ts`, and are NOT gated yet; that is #3403. `EIGHT_TEXT_TOOLS=0` also moves `ollama` and the other two off the gated path. Known costs, tracked in #3404: a suite that was already red costs one run and two refused turns per commit before it goes through, and a suite that times out is rerun (and waited on) at every commit. Tests in `packages/eight/commit-gate.test.ts` drive the real `ToolExecutor` in throwaway git repos, including the pilot's missing-`$` test and a missing runner; they put the running bun first on PATH, so they pass the same with or without bun on the shell's PATH.

### Security - the destructive guard sees through variables, parameter expansion and quoting (#3314, #3315)
- A recursive delete was blocked only when a path literally named home or a system path, so `D=$HOME; rm -rf "$D"`, `rm -rf "${HOME:?}"`, `rm -rf "${X:-$HOME}"` and `rm -rf "$DIR/"*` (an unset `$DIR` leaves `/*`) only escalated. `packages/decide/rules.ts` now checks every text a path could expand to, as text only: a same-line `NAME=value` or `export NAME=value` gives its value, `$HOME` always stays `$HOME`, and any other variable may also be empty unless `${NAME:?}` forbids it, so the safe idiom `rm -rf "${DIR:?}"/*` still escalates. A prefix assignment (`D=/ rm -rf "$D"`) records nothing, as in sh. Bare, single-quoted and double-quoted forms all block.
- `.`, `*`, `./*` and `.*` as a recursive delete target block when the working directory is home or a system path, set by a `cd` earlier on the line (bare `cd` is home) or by the new optional `cwd` argument to `decideRules`. No caller passes `cwd` yet; wiring it from the System One gate is #3398. A project directory or an unknown working directory still escalates.
- Rules only add block cases: the path as written is still checked, so nothing that blocked before passes now.
- A variable assigned more than once on the line counts as any of its values, each expanded against the state before it, because the text cannot tell which assignment ran (`D=/; true || D=build; rm -rf "$D"` blocks). On a line with `&&`, `||` or `if`/`while`/`case`, a first assignment may not have run, so the unset value stays possible. More expansions than the guard can judge (over 64 candidates, nesting deeper than 8, or more than 64 `$` in one argument) block instead of being cut short. Intended new blocks, each with an escalating rewrite: `rm -rf "$TMPDIR"/*` (TMPDIR is unset on most Linux and CI hosts; use `"${TMPDIR:?}"/*`), `rm -rf "$PWD"/*`, `rm -rf "$OUT/bin"` (use `${OUT:?}`), and `rm -rf *` after a relative `cd` that follows `cd ~`. Known cost: `D=$HOME; D=$D/code/app; rm -rf "$D"` blocks; assign once instead.
- The read-only allowlist (`packages/decide/allowlist.ts`) gave `cat "$F"`, `ls "${HOME}"` and `find "$X" -name a` a pass without the judge, because it looked for `$` only outside quotes. Any unescaped `$` inside double quotes, other than `$?`, is now no-opinion. `echo '$HOME'`, `echo $?` and `echo "\$HOME"` keep their verdicts. Tests in `packages/decide/guard-bypass.test.ts`.

### Fixed - the settings store honours $HOME, so tests no longer touch the real settings file (#3391)
- `packages/settings/store.ts` built its path from `os.homedir()`, which Bun fixes at process start, so the temp `$HOME` test preload did not redirect it and any test calling `loadSettings` or `saveSettings` read or wrote the real `~/.8gent/settings.json`. The path now comes from `resolveHome()` (`packages/core/home.ts`, so `EIGHT_HOME` then `$HOME`), resolved on each call. With `EIGHT_HOME` unset and `$HOME` unchanged the path is the same as before. `packages/settings/store-home.test.ts` sets `HOME` to a temp dir after import and checks the path, a save and load round trip, and that `EIGHT_HOME` still wins. The file is removed from the `homedir()` ratchet baseline.
### Changed - an existing temp file again goes to the System One judge on `rm -f`
- `packages/permissions/s1-rm-nothing.ts` passes an absolute path without the judge only when it is absent (#3381, unchanged). An absolute path that exists always goes to the judge, on every platform; the birth-time allowance from #3395 is withdrawn. Tests in `packages/permissions/s1-rm-nothing.test.ts`.
### Changed - System One escalates archive commands that remove their source, and pins redirect targets
- New rule `archive_removes_source` (`packages/decide/rules.ts`) escalates archive commands that delete their inputs: `zip` with `-m`/`--move` (also inside a short-flag group), `tar`/`gtar`/`bsdtar` with `--remove-files`, and `7z`/`7za`/`7zr`/`7zz` with `-sdel`. Plain archiving still passes.
- `packages/permissions/s1-created-files.ts` records a `run_command` redirect target as the session's own only if, when the command ends, the file at that path is still the one created for it before the command started. Each absent target whose parent resolves inside the working directory is created empty just before the command runs (at most 64 per command), so the target exists, empty, while the command runs. A recorded target that the command replaces is forgotten. A command that any rule escalates or blocks, or that changes directory, records nothing. Tests in `packages/permissions/s1-created-files.test.ts` and `packages/decide/rules.test.ts`.
### Changed - `rm -f` of an absent temp path skips the System One judge (#3381)
- Pilot run 2026-10-03_081746 had `rm -f /tmp/todos.json` blocked by the judge with no rule fired. The rm-of-nothing bypass in `packages/permissions/s1-rm-nothing.ts` refused every absolute path. It now passes an absolute path that is absent, has no `..`, `.` or empty segment, and whose parent directory exists and is either a real temp root (realpath of `/tmp`, or of `os.tmpdir()` when that is the macOS per-user `/var/folders/../T`) or reached from one only through real directories (not symlinks) owned by the current uid and not writable by group or others. Every component above the temp root must also be a real directory that group and others cannot write; the temp root itself must be unwritable by group and others or carry the sticky bit (`/tmp` is 1777); the only symlinks followed are macOS's root-owned `/tmp` and `/var`, matched by exact target. An absent intermediate directory, a symlinked one, one owned by another user, or one group or others can write, at any depth, goes to the judge, since it could be swapped for a symlink out of temp before the rm runs (8SO B1, B2, B3). The rules' text test (`isTemp`) is not used, so `/tmp-x/...`, `/tmp/../etc/...`, a temp symlink pointing out of temp, and a `/scratchpad` path outside every real temp root still go to the judge. With no rule fired, a relative path still goes to the judge. An existing file in a temp root always goes to the judge. Globs are still not covered (the other pilot block, `rm -f todos-*.json`). Same flag (`EIGHT_S1_ALLOWLIST`). Tests in `packages/permissions/s1-rm-nothing.test.ts`, including the 8SO negative cases.
### Fixed - `run_command` keeps stderr and the end of long output (#3373)
- `run_command` now returns stderr on a successful exit too, labelled `[stderr]`. Output over 14 KB keeps the first 2 KB and the last 12 KB, and secrets are scrubbed before the cut.
### Fixed - the QA tab no longer switches to apfel off Apple Silicon (#3390)
- The default QA tab is pinned to `apfel` / `apple-foundationmodel`, which only runs on macOS with Apple Silicon. On Linux (and Intel Macs), switching to the QA tab moved the session onto that model, and the first turn went to Ollama as `apple-foundationmodel` and had to fail over. `resolveSpecForRole` now returns no spec for an `apfel` or `apple-foundation` provider unless the host is darwin arm64, so the tab keeps the current provider and model. The provider is trimmed and lowercased before the check, so a hand-edited `Apfel` is gated too. `apps/tui/src/hooks/usePerTabAgents.platform.test.ts` covers linux x64, darwin x64, darwin arm64 and a settings override; it injects the host and the settings loader, so it never reads the machine's `~/.8gent/settings.json`. Still open from the same issue: the apfel onboarding check, the local-engine count in the status bar, the `apple-foundationmodel` failover chain on non-Apple hosts, and the apfel model-list fetch in `apps/tui/src/app.tsx` (`${baseUrl}/models`), which has no timeout.

### Fixed - read_file numbers its lines (#3375)
- `read_file` returned raw text, so a model asked which line something was on counted by hand and got it wrong (pilot l5-locate runs 2026-10-03_004939, _012538 and _064746 cited lines 18, 13 and 19 for an answer on line 16). Every line now starts with its number and a tab, as `cat -n` prints it, including the first-200-lines view of a long code file. New optional `offset` and `limit` arguments read part of a file and keep the file's real line numbers; a partial read ends with a note saying which `offset` to continue from. The tool description tells the model the prefix is not file content.
- `edit_file` still matches the text on disk. When `oldText` fails to match because the model pasted the number prefix in, the error now says so instead of a bare "could not find". When `newText` carries the prefix on every line, the edit is refused with an error naming it and nothing is written, unless the file already holds lines in that exact format. The prefix is never stripped silently, so the bytes written stay the bytes the policy gate checked.
- Auto-memory (`extractAutoMemories`) strips the numbers before it parses `package.json` or reads a README, so project name, description, tech stack and purpose are still recorded. `packages/eight/read-file-line-numbers.test.ts` covers all of this through the real `read_file` path.

### Added - 8DK, the 8gent Device Kit (#3362)
- New `packages/8dk` (`@8gent/8dk`) gives a vessel a device of any kind. A device declares typed capabilities (sensors read, actuators act) with `defineDevice()`. Pairing needs the person's yes: they compare a 6-digit code shown on the device, see every capability, and choose which to grant; nothing is granted by default. The registry keeps only a SHA-256 of the device token, and a device whose manifest changes must pair again. `DeviceToolAdapter` turns each granted capability into an agent tool in the `tools.ts` shape (`device__<device>__<capability>`); ungranted ones are not listed and are denied by name. Every call goes through `evaluatePolicy("device_use")`, so YAML `block` and `require_approval` rules apply on top of the grant, and capabilities marked `confirm` ask on every call. Frames for the daemon WebSocket (`device:hello`, `device:invoke`, `device:result` and the rest) and a call correlator with timeouts are included. Revoking or unpairing takes effect on the next call. `packages/8dk/__tests__/e2e.test.ts` pairs a fake lamp, shows its tool denied before the grant, reaching the lamp and returning after it, and denied again after revocation. Not yet wired: the daemon `/device` route, BODY rail rows, saving pairings to `~/.8gent/devices/`, and decision-audit entries. Concept studied from Meta's Muse Gadget SDK (Apache 2.0); no code copied.
- `device_use` is a policy action, and shadow (hedge) candidates are hard denied it, so a losing candidate can never touch a device.

### Fixed - a repo task that says "build" or "make" goes to the agent, not the HTML pipeline (#3323, #3325)
- The TUI build-intent detector sent any message with a build verb to the single-file HTML artifact pipeline, so a repo task such as "make deck/outline.md and deck/deck.md (Marp) about packages/decide" failed the pipeline's HTML checks until its retry budget ran out and wrote nothing. It now auto-routes only requests for a web artifact (a page, site, dashboard, game or animation). A message that names a repo path, a non-HTML file, or a backtick command, or asks for no web artifact, stays with the agent. Edits to existing code ("make the login page use dark mode", "create a PR for the dashboard changes"), non-HTML outputs such as a sitemap, and framework or in-the-app work also stay with the agent (#3325). The verbatim Rishi pilot l2-solo-deck prompt, which on main 818d48f7 was sent to the pipeline and timed out at 900 s with nothing written, is now a regression test, alongside new-app and new-game asks that must still reach `/build`.

### Fixed - 8gent does not start a model loop past depth 3 (#3341)
- A process started with `EIGHT_AGENT_DEPTH` above 3 (by an agent already at the maximum) now exits with code 77 and an `[AGENT DEPTH BLOCKED]` message on stderr instead of starting. This covers the TUI, `--cli`, `--rpc` and every other command. `--help`, `--version`, `outline`, `symbol`, `search` and `doctor` still run, since they never start a model. The `Agent` constructor refuses too, as a backstop for every path that constructs an `Agent`, including entrypoints other than `8gent`; the exit code there depends on the entrypoint (`run` currently exits 1, not 77, with the same `[AGENT DEPTH BLOCKED]` message). `--cli` never constructs an `Agent`, so it is covered only by the `8gent` startup gate. A process at depth 3 still runs. `run_command` does not pass depth to its children yet; that follows in a later PR.

### Added - agent depth helpers for child processes (#3341)
- `packages/orchestration` gains `childAgentEnv()` (the env a process an agent starts must carry: its depth, one deeper than the agent), `processAgentDepth()`, `processAgentDepthRefusal()`, `AgentDepthError` and `AGENT_DEPTH_EXIT_CODE` (77). Nothing calls them yet; `run_command` and the entrypoint refusal follow in later PRs. The test preload now clears `EIGHT_AGENT_DEPTH`, so a `bun test` started from an agent's shell runs at depth 0.
### Fixed - `8gent onboard --yes` marks onboarding complete (#3329)
- `8gent onboard --yes` set the completion flag on a copy of the profile, so it never reached `~/.8gent/user.json`: `preferences get` kept saying "Onboarded: no", `status` said `onboarded: false`, and the command still printed "Run with --yes". It now completes onboarding through the onboarding manager, which writes the flag and confidence score to disk. The interactive path is unchanged. `packages/self-autonomy/onboard-yes.test.ts` runs the real command in a throwaway home.
### Fixed - `8gent doctor` checks the files 8gent actually writes (#3328)
- Doctor looked for `~/.8gent/memory.db` and `~/.8gent/config.json`, which the memory, onboarding and settings stores do not write, so it reported "No memory DB yet" and "No config" on a set-up machine. It now checks `~/.8gent/memory/memory.db` (or `$EIGHT_DATA_DIR/memory/memory.db`), `~/.8gent/user.json` with its onboarding state, and `~/.8gent/settings.json`. Doctor does not create the memory, profile or settings files. It does still write `~/.8gent/policy-checksum` on first run through the NemoClaw check; that is a separate issue (#3344). `packages/settings/doctor-paths.test.ts` drives the CLI in a throwaway HOME (with `EIGHT_HOME` and `EIGHT_DATA_DIR` cleared) before and after `onboard --yes` and `memory stats`, and covers the `EIGHT_DATA_DIR` memory path.

### Fixed - spawn_agent cannot recurse past depth 3 (#3331)
- An agent could start agents that started agents with no limit. `spawn_agent` (both tool surfaces) and `AgentPool.spawnAgent` now refuse once an agent is at `MAX_AGENT_DEPTH` (3), before anything starts. Depth follows each async context and passes to child processes in `EIGHT_AGENT_DEPTH`. A malformed `EIGHT_AGENT_DEPTH` counts as the maximum, not as 0. The refusal reads `[AGENT DEPTH BLOCKED]`, so the TUI tool trail shows it as blocked instead of "Started agent". Depth is not yet passed through `run_command` or `WorktreePoolAgent` (#3341, #3342).

### Fixed - the Linux login service installs where systemd looks (#3293)
- `8gent daemon install` wrote the systemd unit (and on macOS the launchd plist) under `HOME` or `EIGHT_HOME`, so with either pointing elsewhere `systemctl --user enable` failed with "Unit file com.8gent.daemon.service does not exist". The service definition now goes under the account's own home, the one the service manager searches and the daemon runs with.

### Fixed - the test suite no longer leaves temp folders behind (#3285)
- Test suites left about 24k folders and 11 GB in the OS temp folder, which pushed the Mac CI runner below its disk floor. A test run now keeps its temp files in one `8gent-test-tmp-<pid>-*` folder (TMPDIR, TEMP and TMP all point there, so Windows is covered too) and removes it afterwards. Folders left by an interrupted run are swept on the next run once their process is gone and they are 6 hours old. The 11 test files behind the biggest leaks make their temp folders with `tempDir()` from `tests/temp-dirs.ts` and clean them up, and the run fails if one of them leaks again. Other leftovers are listed in a `[temp-dirs]` line. `tests/preload-temp-dirs.test.ts` tests the guard and runs as part of `bun run test`.

### Fixed - /model auto:free runs a free model, never a paid one (#3289, #3292)
- In the TUI, `/provider openrouter` then `/model auto:free` silently switched to a paid OpenRouter model. auto:free now resolves to a live `:free` id and refuses any paid id; if no free model is reachable, the tab says why and retries. Failed lookups are not cached, and the model list request gives up after 10 s.

### Fixed - the anonymizer masks the running user's identity, not a fixed one (#3283)
- The owner identity is now read at runtime from the git config and the OS account, then cached on the git config's change time, so a mid-session `git config --global` change is picked up. Account-like names (admin, ubuntu, GitHub Actions) are not treated as a person's name.

### Fixed - CI Validate is green on GitHub-hosted ubuntu again (#3287, #3288)
- The type-check and lint errors on main are fixed. The Validate job now installs ripgrep before the Test step: the `locate` tool runs `rg`, and the ubuntu runner does not have it, which broke 16 locate tests. Without rg, `locate` still says so in its answer, and that path keeps its own tests. `tools-open-on-write.test.ts` now restores `process.stdout.isTTY` to its original descriptor. Before, it left behind a read-only copy on a non-TTY stdout, so `auto-tune.test.ts` failed 15 tests whenever it ran later in the same process.

## [0.18.0] - 2026-10-01

### Fixed - npm install works on a bare machine (#3259, #3256)
- `npm install -g @8gi-foundation/8gent-code` no longer fails on a Linux box without Python or a compiler. `node-pty` and the tree-sitter packages are optional dependencies, so a failed native build is skipped instead of aborting the install. `dist/pty-bridge.cjs` now ships in the package, and without `node-pty` a terminal tab says how to install the build tools instead of crashing. CI installs every candidate package in a clean `node:22-bookworm-slim` container with install scripts on.

### Fixed - web_fetch only reaches the public internet (#3255, #3233)
- `web_fetch` refuses loopback, private, link-local, CGNAT and cloud metadata addresses (IPv4 and IPv6, including mapped forms), pins each connection to the address it checked, and re-checks every redirect hop (at most 5). A host whose DNS answers mix public and private addresses is refused.

### Fixed - the system prompt and tool list stay byte-stable (#3258, #3222)
- Memories, prior sessions, self-appended context and voice mode now travel as a context message after the system prompt, and tool loading is append-only, so a local model can reuse its prompt cache. On qwen3.5:9b-32k the second turn's prefill went from 2.4 s to 0.56 s.

### Fixed - harness notes reach the model (#3262, #3260)
- Vision descriptions, proactive questions and pre-tool-router prefetches were added as extra system messages and then filtered out before every model call. They now reach the model as context messages.

### Fixed - Linux CI builds no longer fail on the container path (#3257)
- The build-path check matches a build root only at a path boundary, so `/work` no longer matches `/workspace` inside bundled dependencies.

### Changed - an agent can remove its own scratch files without the System One judge (#3178, #3177)
- A plain `rm -f` of files the same agent created this session (with `write_file`, or a `>` / `>>` redirect in `run_command`), untracked by git and inside the workspace, no longer goes to the judge. The pilot's `bun test > bunout.txt` then `rm -f bunout.txt` now passes System One. Files it only modified, files another tab made, tracked files, `rm -r` and globs are judged as before. The record is in memory, per agent.

### Changed - System One on by default, one shared judge per machine (#3176, #3048)
- System One now checks every agent shell command unless `EIGHT_SYSTEM_ONE=0`. Unset, it asks only a calibrated judge (Selene today) and, when there is none or it cannot answer in time, checks with the safety rules and the read-only allowlist alone, saying so once. `EIGHT_SYSTEM_ONE=1` (and Guarded) is strict: any judge found is asked; when none can answer, a block rule still blocks and everything else goes to the person on the normal card, never an allow (#3193). Headless, with no person, that stays a refusal. Every refusal now tells the agent not to run the same command again, which stops the retry loop.
- The shared judge (`EIGHT_S1_SHARED_JUDGE`) is on by default, so a machine loads Selene once in its local Ollama rather than once per tab; `EIGHT_S1_SHARED_JUDGE=0` opts out. Before the first judge load, one line names the model, where it loads and its size.

### Added - permission modes on Shift+Tab (#3173, #3175, #3170, #3174)
- Shift+Tab cycles the focused tab through Plan (reads and plans, changes nothing), Ask (the default, unchanged), Guarded (System One checks every shell command; safe steps run, risky ones still ask) and Infinite (never asks, except the always-blocked list; back to Ask after 30 minutes). Each tab keeps its own mode. A child agent gets the stricter of its parent's mode and the one it asked for. The footer, tab tags, header chip and a one-line chat note show the mode. Shift+Tab no longer moves to the previous tab; Ctrl+1 to Ctrl+9 still do. Guide: `docs/guides/permission-modes.md`.

### Added - one shared System One judge per machine (#3163, #3162)
- On by default since #3176 (`EIGHT_S1_SHARED_JUDGE=0` opts out). The shared judge lets every 8gent process on a machine use one copy of System One's model on the local Ollama server (`EIGHT_DECIDE_OLLAMA_HOST`, default `http://localhost:11434`) instead of loading one each. Same model, same verdicts. If the shared server stops answering mid-session, that session loads its own copy and carries on; it never falls back to another server or model. Off by default. Guide: `docs/guides/system-one-shared-judge.md`.

### Fixed - NO_COLOR is honoured across the whole interface (#3172, #3171)
- `NO_COLOR=1` now turns colour off everywhere, keeping bold, dim and inverse so the cursor stays visible. `FORCE_COLOR` still wins over it. The dark theme's danger red is brighter so it meets contrast guidelines. Guide: `docs/guides/no-color.md`.

### Fixed - Ctrl+letter shortcuts no longer type their letter (#3167, #3166)
- Pressing a shortcut such as Ctrl+P also typed `p` into the chat box, hidden until the palette closed. The chat box now ignores Ctrl+letter as text.

### Fixed - one Ollama host resolver (#3157, #3149)
- System One (`packages/decide`) and the rest of the harness resolved `OLLAMA_HOST` differently: a bare host with no port (`gpu-box`, which the ollama CLI accepts) got `:11434` for chat and no port (so port 80) for System One. Both now use one resolver, `packages/local-model-server/ollama-host.ts`.

### Added - llama-server as a local server, phase 2 of #3149 (#3155)
- `EIGHT_LOCAL_SERVER=llama-server` runs 8gent Code on llama.cpp's `llama-server` with no Ollama at all: a `llama-server` provider on the text-tool path (`LLAMA_SERVER_URL`, default `http://127.0.0.1:8080`), and nothing in the process probes, lists or calls Ollama (onboarding, health, readiness, task routing, System One). Unset, today's Ollama behaviour is unchanged. Guide: `docs/guides/llama-server.md`.
- The llama-server adapter (`packages/local-model-server/llama-server.ts`) passes the same contract suite as the Ollama adapter.
- System One finds its GGUF in `~/.8gent/models/decide/*.gguf` before the Ollama store, so a machine with no Ollama can still run it (or set `EIGHT_DECIDE_GGUF`).

### Added - local model server layer, phase 1 of #3149 (#3150)
- Local model server layer, phase 1 of #3149 (`packages/local-model-server/`): a `LocalModelServer` interface with capability flags and an Ollama adapter, so Ollama becomes one server among equals rather than the assumed default. Eight model-list and health call sites (`/api/tags`) now go through it with no behaviour change, proven by a snapshot of their requests and results taken before the move. A contract suite holds every adapter to the same rules.

### Changed - the working spinner traces a figure of eight (#2952)
- Working spinner traces a figure of eight instead of the stock braille square; frames are a pure, tested path and hold still when animations are off (`apps/tui/src/lib/figure-eight.ts`).

### Fixed - Telegram bridge: who may drive it, where it answers, who may consent (#2960, #2959)

- **Sender allowlist.** The bridge authenticated inbound updates by chat id
  only, and `dispatch-policy.ts` grants the `telegram` channel full
  capability on the strength of that, assuming the allowlisted chat is one
  operator's private chat. In a group that assumption fails: every member
  could prompt an agent holding tools in the operator's home directory.
  `TELEGRAM_AUTHORIZED_USER_IDS` is now checked at the same three points as
  the chat allowlist, and fails closed: without it, a private chat behaves as
  before and a group rejects every sender.
- **Reply routing.** The daemon's wire format carries no chat id, so every
  outbound went to the first allowlisted chat. With a group and a private
  chat both allowlisted, a message sent in one was answered in the other. The
  bridge now remembers the originating chat for the turn in flight and
  replies there; the adapter and file sender take a resolver instead of a
  fixed string. One field is sound rather than racy because `agentBusy`
  already admits one prompt at a time.
- **Consent.** Approvals were bound to the chat, not the person, so any
  allowlisted sender could press Approve on a tool call, and an approval
  raised in one chat could be resolved from another. Approvals are now bound
  to the chat that raised them, and only `TELEGRAM_OPERATOR_USER_IDS` may
  decide. Conversation and consent are different powers.

### Fixed - the repo lint passes, so the CI gate can gate (#2962, #2961)

- `bun run lint` had exited 1 on `main` since at least 2026-08-25, so the
  `Validate` job failed on every pull request whatever it contained. Ten
  errors across nine files are fixed: seven mechanical and
  behaviour-preserving, three where the rule mis-reads correct code and now
  carries a suppression with its reason. The 1417 warnings are untouched;
  this makes the gate work, it does not clean the repo.

### Added - `/retro` ships as a bundled skill (#2956)
- `/retro` ships as a bundled skill, so the session retrospective is available out of the box: a short Socratic interview, a determinism table sorting friction into hook, command, advice or decision record, and a cap of one adopted change per retro.

### Added - Table: on-demand real-time message narration, never persisted (#2878, #2877)

- `packages/table/message-speak.ts` (new): a "play this message aloud"
  affordance for ANY Table message - synthesizes from the message's live
  `content` in real time via `narrateTurn`/`voiceFor`/`HUMAN_VOICE`, reused
  verbatim from `huddle-voice.ts` (no second TTS engine, no reimplementation
  of the Supertonic call). `voiceForAuthor` picks an agent author's own
  officer voice or `HUMAN_VOICE` for a human author - declared identity,
  never inferred, same rule huddle-voice.ts already documents.
  `synthesizeMessageSpeech` writes to a fresh temp directory removed in a
  `finally` regardless of outcome - nothing survives past the call, by
  design (this deliberately replaces the earlier persisted `audio_url`
  direction from #2875/#2876 as the general pattern; that stays as-is for
  the one message that already has a curated narration).
- `packages/table/store.ts`: new public `TableStore.getMessage(id)`.
- `packages/daemon/gateway.ts`: wires `POST /table/messages/<id>/speak` in,
  mirroring the existing `handleAuditAccess` route idiom. Read authority
  reuses the exact `listMessages({viewerId})` check `channel:presence`
  already exercises - a private channel `human:local` isn't a member of
  403s, never leaks content.
- 13 new tests in `packages/table/__tests__/message-speak.test.ts`: voice
  selection, ephemeral cleanup on success AND failure (injected fake
  narrator, fast), full HTTP status mapping (404/403/422/503/200), and one
  test that shells out to the REAL `supertonic` binary end to end (skipped,
  never failed, when it is not installed) proving genuine non-silent WAV
  bytes come back and no temp file survives.

### Added - Table message narration: nullable audio_url/audio_duration_ms (#2876, #2875)

- `packages/table/schema.sql`: `messages` gains nullable `audio_url TEXT` and
  `audio_duration_ms INTEGER`. Additive only - a message without narration is
  unaffected, and `TableStore`'s constructor now runs an idempotent
  `ALTER TABLE` migration so an existing `~/.8gent/table/table.db` (from
  before `CREATE TABLE IF NOT EXISTS` could pick up the new columns) gets
  them too, on every open, safely re-run.
- `packages/table/types.ts`: `Message.audioUrl` / `Message.audioDurationMs`.
- `packages/table/message-audio.ts` (new): the daemon-local narration path
  shape `/table/audio/<messageId>/<file>` and its loopback-only HTTP handler,
  mirroring `huddle-stage.ts`'s `handleStageHttp` for a single persisted
  message instead of a live huddle turn.
- `packages/table/store.ts`: `postMessage` accepts optional
  `audioUrl`/`audioDurationMs` at creation; new `attachAudio()` narrates an
  already-posted message after the fact (author-only, same authority as
  `editMessage`).
- `packages/daemon/table-routes.ts`: `message:post` validates an optional
  `audioUrl` against the daemon's own served-path shape; new
  `message:attachAudio` frame for the after-the-fact case, broadcasting the
  existing `message:updated` event.
- `packages/daemon/gateway.ts`: wires `handleTableAudioHttp` in alongside the
  huddle stage's HTTP handler.
- 2 new tests in `packages/table/__tests__/store.test.ts` covering
  `postMessage` with/without audio and `attachAudio`'s author-only authority
  and round-trip through a re-read.

This is the daemon half of Table message narration; the relay proxy
(8gent-glasses#pending) and Flow playback UI (8gent-flow#pending) land as
their own repos' changes.

### Added - Per-model benchmark attribution, step 4 (#2772, #2758)

- `benchmarks/gate.ts`: the results TSV's `model` column now feeds a second
  aggregate, `computeModelCategoryAverages`, tracked in `scores/ledger.json`
  under a new `models` field (`model -> category -> {avgScore, benchmarkCount}`).
  A router change or an `eight-1.0` checkpoint bump is now attributable to
  the model that produced it, separate from the blended category number.
  `--update` writes both breakdowns; `bun run benchmark:gate` prints a
  per-model attribution table by default (`--no-by-model` to hide it).
  Purely informational — a single model regressing never fails the gate,
  only a category's blended average does, unchanged from step 1.
- `scores/ledger.json`, `scores/README.md`, `benchmarks/README.md` updated
  for the new schema field and CLI flag.
- 13 new tests in `benchmarks/gate.test.ts` covering per-model averaging,
  ledger merge/round-trip, comparison, and report formatting.

### Added - Continuous public benchmark gate, step 1 (#2765, #2758)

- `benchmarks/gate.ts`: compares fresh `benchmark:v2` category averages
  against the checked-in `scores/ledger.json` baseline and hard-fails on
  any regression beyond a configurable noise band (default 3 points). New
  categories bootstrap instead of failing; `--update` seeds the ledger from
  a trusted run.
- `scores/ledger.json`: the public score ledger, starts empty - it is only
  ever written by real `benchmark:v2` runs, never hand-typed.
- `.github/workflows/benchmark-gate.yml`: runs the gate on every PR
  touching `packages/eight`, `packages/providers`, or `packages/tools`.
  Skips grading (never fabricates a result) when `OPENROUTER_API_KEY` isn't
  configured on the repo.
- Added the `benchmark:v2` script alias (`benchmarks/autoresearch/harness-v2.ts`)
  that README.md and AGENTS.md already documented but `package.json` was
  missing, plus `benchmark:gate` / `benchmark:gate:update`.

### Fixed - Full local test suite green (#2781)

- `pty-bridge.cjs` now restores the execute bit on node-pty's prebuilt
  `spawn-helper` before the first spawn. `bun install` skips the package's
  lifecycle scripts, so the helper landed non-executable and every
  `pty.spawn` on macOS failed with "posix_spawnp failed." - the 5
  PtySession test failures on any bun-installed tree.

### Fixed - CI Test step green again, unblocking merges (#2781, #2741)

- The research-evaluate generator emitted unbuilt-utility specs as guaranteed-fail assertions (~68 across 14 modules), turning the whole suite red. They now generate as `test.todo` - pending work, never a fake pass and never a failure.
- `isRemoteProvider` no longer treats the hyphenated `lm-studio` as a remote provider.
- The Marlin capability tests take an injectable home directory, so the not-installed path is exercised against empty state instead of a developer's real `~/.8gent` venv.

### Fixed - 8gent Computer voice loop and proof rail (#2731, #2722)

- Added an in-panel mic toggle that stops voice capture and keeps it off across panel opens until the user explicitly resumes it.
- Kept completed tool-step proof visible after `done`, and brings the panel forward for live tool activity, approval prompts, errors, and completion.
### Added - 8gent-flow Mac vision and control relay (#2719, #2721, #2718, #2720)

Introduced `@8gi-foundation/8gent-flow`, a Mac-first relay that reuses
`@8gent/eyes` for local screen capture and exposes token-gated WebSocket frames
for iOS or browser clients on the same network.

- Defaults to loopback with a generated pair token.
- Supports LAN binding with `--host 0.0.0.0` for iOS pairing.
- Sends JPEG or PNG frame payloads, with metadata-only and max-frame-size modes.
- Accepts authenticated `control.*` messages for click, hover, scroll, type, and
  keypress control from paired iOS clients.
- Keeps control disabled on `--no-token` relays unless explicitly allowed.
- Reports missing macOS Screen Recording and Accessibility grants explicitly.

### Changed - GitHub Actions usage reduction (#2679)

Org-level Actions quota was hit (3,000 min/month). Workflow changes to bring usage well under cap:

- `swift` job moved out of `ci.yml` into new `swift-nightly.yml` (nightly cron + manual dispatch + PRs that touch `apps/8gent-computer/**`). macOS runners bill at 10x; running it on every PR was the dominant cost.
- `lint.yml` deleted - `bun run lint` is already part of `ci.yml`.
- `semgrep.yml` and `gitleaks.yml` no longer trigger on push to main (PR + weekly cron + manual is sufficient).
- `concurrency: cancel-in-progress` added to `ci.yml`, `semgrep.yml`, `gitleaks.yml`, and `8gent-review.yml` so superseded runs no longer complete needlessly.

### Added - `fs.register` JSON-RPC method on the daemon `/store` route (#2662)

Out-of-process clients (8gent-computer, future TUI vessels) build their own workspaceIds and call `fs.list / fs.read / fs.write`. The daemon previously rejected unknown ids with `fs: unknown workspaceId` and had **no wire method to register one** - `_registerWorkspace` was in-process only. New `fs.register({ workspaceId, root })` lets clients register a workspace before file ops:

- Validates `workspaceId` against `/^[A-Za-z0-9_.-]{1,128}$/` (KV-key injection safe).
- Rejects the reserved id `default` (which still resolves via `EIGHT_WORKSPACE_ROOT` / `process.cwd()`).
- Requires `root` to exist and be a directory; refuses the filesystem root.
- Idempotent on the same id; updates the mapping otherwise.

Paired with 8gent-computer's `ensureWorkspace` calling this method on first sight of each workspaceId, this clears the "unknown workspaceId" failure that blocked every file op in fresh chats.

## [0.17.3] - 2026-05-22

### Added - Adaptive three-model orchestration pipeline (#2648)

Planner, engineer, and judge roles are each assigned to a distinct local model, matched to that model's strength. Dynamic local-model detection probes what is actually installed on the host and assigns roles accordingly, so the pipeline adapts to the machine instead of assuming a fixed model set.

### Added - `/build` slash command (#2655)

Runs the adaptive three-model pipeline end-to-end from the TUI.

### Added - Video ingestion via Marlin + Whisper (#2636, #2638, #2641)

The `eyes` package gains a Marlin caption + Whisper transcript sidecar. A new `extract_video` tool chunks long videos and merges the results; the knowledge-graph video-extractor folds them into the graph with extended `EntityType` / `RelationshipType` coverage.

### Added - KnowledgeGraph over `graph.*` RPC (#2642)

The daemon `/store` route now exposes the project-scoped KnowledgeGraph over `graph.*` JSON-RPC, alongside the existing `session.*` / `kg.*` / `fs.*` surfaces.

### Added - MaxVoiceMode skill (#2649)

New skill that narrates work aloud via local TTS at each milestone.

### Added - Living plan rail + task discipline

The TUI gains a living plan rail, and the system prompt enforces task discipline so multi-step work tracks against an explicit plan.

### Fixed - `/goal` command was silently inert

`GoalClient` was never wired into `CommandInput`, so `/goal` did nothing. Wired it through, added a version header to the TUI, restored the missing `lmstudio` case in `runtimeForProvider`, and fixed the `LiveFocalStrip` vs `LiveFocalStripWithGoal` swap that suppressed goal output.

### Fixed - Loop observability + fixer budget (#2653)

Repaired loop observability in the orchestration package and set a saner fixer-iteration budget.

### Changed - Unified instruction files into one source under three names

`AGENTS.md`, `8GENT.md`, and `CLAUDE.md` previously held three different documents that drifted apart - different harnesses read different files and got different instructions.

- **One file, three names** - all unique content (repo dev instructions, the autoresearch dev process, and 8GI ecosystem context) is consolidated into `AGENTS.md`, the vendor-neutral open standard. `8GENT.md` and `CLAUDE.md` are now symlinks to `AGENTS.md`, so any agent harness reads identical instructions regardless of which filename it looks for. Edit `AGENTS.md` only.
- **Caveat** - the 8GI ecosystem section of `AGENTS.md` is auto-propagated from `8gi-governance`. If that sync overwrites this file, ecosystem-section edits must be made in `8gi-governance`, not here.

### Fixed - CI secrets scan false-positived on test fixtures

The `Validate` job's grep-based secrets scan flagged `HMAC_SECRET = "test-secret-for-local-mode-suite-only"` in a daemon test file. It is an obvious fake fixture, not a credential. The scan now excludes `__tests__` directories and `*.test.ts` files; `gitleaks` (the `Secret Detection` job) still scans those with proper allowlisting.

### Fixed - Instruction loader silently shadowed AGENTS.md

The instruction loader (`packages/eight/instruction-loader.ts`) searched `8GENT.md`, `AGENTS.md`, `CLAUDE.md` in that order with first-match-wins per directory. In any repo carrying both `8GENT.md` and `AGENTS.md` (including this one), `8GENT.md` shadowed `AGENTS.md`, so the vendor-neutral open-standard file was never loaded by the agent.

- **AGENTS.md is now canonical** - reordered the search to `AGENTS.md > 8GENT.md > CLAUDE.md`. The vendor-neutral open standard wins; 8gent is not married to any vendor. `CLAUDE.md` stays a last-resort fallback that loads only when no vendor-neutral file is present, minimizing vendor exposure. Added `instruction-loader.test.ts` locking the priority order and nested-directory merge behavior.

### Fixed - CI test failures on non-macOS / shared runners

Two pre-existing test failures broke the `Validate` CI job on every Linux run, unrelated to feature code.

- **`keychain.test.ts` threw on non-macOS** - the `afterAll(cleanup)` hook was registered unconditionally, and `cleanup()` constructs a `KeychainVault`, whose constructor throws on any non-Darwin platform. The `describe` block was already `skipIf`-guarded but the hook was not. The hook is now registered only on macOS.
- **`perceptual-diff.test.ts` 4K perf budget flaked** - the 4K-diff test asserted a hard 200ms wall-clock cap, which shared CI runners exceed on jitter alone (observed 235ms). The budget is now CI-aware (`1000ms` on CI, `200ms` locally) so it still trips on a gross multi-x regression without flaking.

### Fixed - Windows install blockers (5 bugs)

The npm package shipped with five blocking bugs on Windows that left users stuck right after install. All five fixed.

- **Hardcoded source paths in dist** - `bin/8gent.ts` referenced `__dirname/../apps/...` / `../scripts/...` / `../packages/...` for the TUI, benchmark, demo, and pet commands. None of those source paths exist in the npm tarball (only `dist/cli.js`, `bin/8gent-run.js`, and a handful of assets ship), so spawned children silently failed on a clean install. Replaced with a `BIN_DIR` derived from `import.meta.url`, added `repoRoot()` detection for dev-only commands (clean error if absent), and bundled the TUI as `dist/tui.js` shipped via the `files` whitelist. The TUI command now prefers the bundled entry and only falls back to source when running from a checkout.
- **`keys.env` "merged 0 keys" on Windows** - `readKeysFile` did not strip the UTF-8 BOM. Notepad saves `.env` files with a BOM by default, so the first key parsed as `﻿OPENAI_API_KEY` and every downstream provider lookup missed. Strip the BOM before parsing.
- **`config.model.includes()` crash from CLI args** - `createModel()` and `getRetryConfig()` in `packages/ai/providers.ts` called `.includes(":free")` without checking that `model` is a string. CLI flag parsing can pass `undefined` when no `--model` is given. `createModel` now throws a clear error naming the provider; `getRetryConfig` guards the membership test.
- **Ollama forced as default provider** - `defaultRoleConfig()` hardcoded `{ provider: "ollama", model: "qwen3:14b" }` for any non-Darwin system, and `ModelFailover.resolve()` used the same as its hail-mary. Both now default to OpenRouter `auto:free` so a fresh Windows / Linux install boots into a working state instead of an `ECONNREFUSED 11434`. The TUI `loadProviderSettings` no longer pins `"ollama"` when `providers.json` is absent - it leaves the slot empty so `detectBestLocalProvider()` runs.
- **`qwen3:14b` returned as universal fallback** - `defaultModelFor()` in `packages/eight/run.ts` returned `qwen3:14b` for any unknown provider. `runRunCommand()` now probes ollama once and only routes to it when the daemon answers; otherwise falls through to `openrouter` / `auto:free`. Also fixed `packages/eight/index.ts` env var typo (`EIGHGENT_MODEL` -> `EIGHT_MODEL`) and the bogus `glm-4.7-flash:latest` default model.

### Added - Chat scrollback (mouse wheel + keyboard)

The TUI center panel is now scrollable. Pinned to the bottom by default; scroll up to read earlier turns without being yanked back when new output streams in.

- **Mouse wheel / trackpad** (#2596) - new `useMouseScroll` hook enables xterm SGR mouse mode (`?1000h ?1006h`) and patches both `stdin.emit('data')` and `stdin.read()` so wheel bytes are consumed before Ink's input parser sees them (Ink reads via `'readable'` + `stdin.read()`, not `'data'`). Mouse mode is torn down on four exit paths so the terminal is never left in capture mode.
- **Keyboard** (#2596) - `shift+↑/↓` scrolls one message, `shift+PgUp/PgDn` scrolls five. Plain arrows stay owned by the input field.
- **Row-budget slicing** (#2596) - the visible window is now sized by estimated rendered rows, not message count. Fixes the streaming overlap artifact (rendered tree never exceeds the container) and makes scroll actually move on chats with few messages.
- **Content-anchored offset** (#2596) - new messages arriving while the user is scrolled up no longer shift the user's view; the offset bumps to keep them on the same content.
- **Stable pages** (#2597) - scrolling a finished assistant reply out of view and back no longer replays the typing animation. Animated message IDs are tracked so re-mounts render statically.

Tradeoffs: drag-to-select needs Option (macOS) / Shift (Linux) while focused; tmux users need `set -g mouse on`.

### Added - Daemon `/store` route (#2575)

New WebSocket route at `ws://localhost:18789/store` exposing `session.*`, `kg.*`, and `fs.*` over JSON-RPC 2.0. Lets the 8gent-code TUI and 8gent-computer Electron share sessions, knowledge-graph chunks, and workspace files against one daemon. `kg.*` chunks files into `MemoryStore` behind filename + content secret gates. `fs.exec` is deny-by-default with a small allowlist plus hard-deny patterns (download-pipe-execute, base64 smuggling, root-tree destructive commands). Capability-token auth (`~/.8gent/server.token`, mode 0600, constant-time compare); audit logs to `~/.8gent/audit/`. 29 daemon tests pass.

### Added - Body-parts visual indicators (#2553)

New BODY section in the ActivityRail shows eyes/hands/handeyes state: `○` disabled, `●` idle, `◉` in-flight. `/eyes`, `/hands`, `/handeyes` slash commands toggle per-session enabled state. Capability detection at launch auto-enables based on `cliclick` (hands) and the bundled AX bridge (eyes); handeyes needs both. New `useBodyParts` hook, 6 new ActivityRail tests. Also corrected `bin/8gent.ts` VERSION drift (0.16.0 → 0.17.0).

### Added - Intro splash narration (#2555)

Pre-rendered KittenTTS (Jasper voice) narration plays over the launch music, synced to the splash typewriter cascade. Bundled as `apps/tui/sounds/splash-narration.mp3` (218KB) so the TUI startup path stays dependency-free. Splash schedule extended to 13.5s; music volume lowered so the narration reads clearly. Killed on exit / SIGINT / SIGTERM / `/quiet`.

### Added - Governance tables in unified 8GI Convex (#2540)

Ported 8 governance tables (submissions, agent_mail, agentTranscripts/Sessions/Context, shareLinks/Viewers/Events) and 6 function files into `packages/db/convex/` so the unified 8GI Convex serves all 8GI surfaces, not just 8gent-code telemetry. 22 new indexes, no table collisions. Phase 1 of the Convex consolidation; unblocks the dashboard fold-in (#2550).

### Changed - Intro splash copy (#2554)

The launch splash now leads with the IGI pitch ("Your intelligence shouldn't be a subscription." / "Take back custody of your cognition." / "Infinite General Intelligence. free. local. open.") instead of the older Infinite-Gentleman framing. Same cascade timing and typewriter speed. The Infinite Gentleman line stays a sub-brand elsewhere (decks, social bios).

### Removed - `apps/dashboard` (#2550)

The standalone admin dashboard was folded into 8gi-governance's `/internal/platform/*` during the 2026-05-10 Convex consolidation and ran side-by-side for a day with no regressions. Deletes the entire app and drops one transitive dependency from `bun.lock`. Two historical doc references remain (descriptive, not build deps).

### Fixed - Utility tabs render in non-chat modes (#2543)

Settings, Notes, Ideas, BTW, Questions, Kanban, Music, Projects, and Terminal tabs were invisible whenever the agent was in any non-chat viewMode (PLANNING, RESEARCHING, etc.). The utility-tab switch in `renderMainContent` was gated on `viewMode === "chat"`. Utility tabs are workspace-scoped, not mode-scoped; dropped the guard.

---

## [0.17.0] - 2026-05-10

### Added - Body-parts taxonomy (eyes + handeyes shipped end-to-end)

The agent now sees and selectively coordinates eyes+hands when stuck. Three body-parts in the public spine: hands (motor), eyes (perception), handeyes (sensorimotor coordination).

**Eyes** (perception) - shipped across 7 PRs (#2497 + #2500 + #2502 + #2511 + #2513 + #2524 + #2528 + #2532 + #2535):
- Spec + decisions: capture, annotate, locate, describe, wait_for, diff, observe; permission model; failover chain. RFC §8 closed (logical coords + Frame.scale, focused-display default, 2s/16-frame annotation cache, perception:remote tier on data egress, macOS-first cross-platform path).
- **Bundled native AX bridge** at `~/.8gent/bin/8gent-ax-bridge` - drops the Homebrew peekaboo dependency. Conceptual ancestry: Peekaboo (MIT, Peter Steinberger 2025); full attribution at `packages/eyes/native/NOTICE`. Built via `bash packages/eyes/native/build.sh` or `bun install` postinstall.
- **Real perceptual diff** via pngjs - downscale then flood-fill into bounding rects, ~144ms on 4K. observe() events now carry meaningful changed regions.
- **Vision-router wiring** with two-phase VisionProvider contract (`resolveProviderId` then tier-check then `describe`). Closes #2508 privacy bug. Routes via Ollama (local) or OpenRouter (remote).
- **Agent tools**: `eyes_see`, `eyes_find`, `eyes_describe`, `eyes_wait_for`. New `perception` category in tool-registry. Singleton Eyes instance per process.
- **Headless CLI**: `apps/8gent-eyes/` with 7 subcommands + `--intent` natural-language routing. AgentCLIDesign-compliant (--json default, deterministic exit codes 0/1/2/3/64, no telemetry beyond audit).
- **Tail polish** (#2535): async PNG I/O on observe hot path; structured PNG-parse error guard with 3-strike auto-dispose; `thresholdDelta` rename with deprecated `thresholdPx` alias; build.sh kebab-case fix.

**Handeyes** (sensorimotor coordination) - shipped across 2 PRs (#2531 + #2536):
- Third body-part. Depends on hands AND eyes. Selectively engaged when the agent is observably stuck on a hands-only or eyes-only flow.
- 5 compound tools: `handeyes_locate_and_click`, `handeyes_click_and_verify`, `handeyes_type_and_confirm`, `handeyes_engage_struggle_mode`, `handeyes_exit_struggle_mode`. New `coordination` category in tool-registry.
- Engagement loop with 3 of 4 triggers live: zero-hits-twice, wait-for-timeout, click-without-screen-change. Trigger 4 (DoomLoopDetector emitter) wired but pending shared-instance accessor in agent loop.
- Architectural anchor: multi-agent orchestration applied to body-parts. Reuses existing OrchestratorBus; eyes-worker and hands-queue are in-process typed objects rather than spawned sub-agents (rationale: tight observe loops would burn a model slot per session).

**DoomLoopDetector** (#2534, RFC #2527 Option A):
- Now extends EventEmitter and emits `'stuck'` with `{ period, reps, windowSize, detectedAt, signatures }` payload when a cycle is detected. Synchronous `check(): boolean` API preserved unchanged. Typed `on/off/once` overloads.

Tests across this release: 32 (eyes) + 9 (eyes-cli) + 39 (handeyes) + 20 (doomloop) + 47 (eyes-polish) = 147+ across the body-parts work, all green.

### Added - v0.14 "Hardened Kernel" (extracted from OpenMonoAgent under CleanRoomPort, no AGPL source copied)

Trust primitives:
- **DoomLoopDetector hardening** (#2461 → #2472). Period-1 to period-4 cycle detection on a sliding 12-call window with normalized JSON args. Catches `AAA`, `ABAB`, `ABCABC`, `ABCDABCD` patterns. 13 tests. `packages/eight/tool-loop-detector.ts`.
- **SecretScanner** (#2464 → #2477). Scrubs known provider secrets (AWS, GCP, Anthropic, OpenAI, DigitalOcean, GitHub, Slack) from tool output before the model sees it. 53 tests, 1MB scrub <50ms. Wired in `packages/eight/tools.ts` post-execution. Format: `[REDACTED:<rule-id>]`.
- **PathGuard** (#2465 → #2476). Static deny-list for ~/.ssh, ~/.aws, ~/.kube, .gitconfig, .netrc, id_rsa, id_ed25519 + UNC paths + device files. Runs before NemoClaw. 30 tests + 1049 permissions-suite green. `packages/permissions/path-guard.ts`.
- **BashParser** (#2466 → #2483). Parses bash into segments + redirections + subshells (recursion capped at 50) so policy engine evaluates per-subcommand. 23 new + 93 permissions tests. `packages/tools/bash-parser.ts`. Runtime spawn-site wiring in follow-up #2484.

Context engineering:
- **ToolResultCache** (#2462 → #2478). LRU 500 entries / 30-min TTL / mtime-validated cache for read-only tool results. Exposes `resultCache` + `isReadOnlyTool()` helpers from `tool-registry.ts`. 13 tests.
- **ArtifactStore** (#2463 → #2479). Tool outputs over 50KB persist to `~/.8gent/artifacts/{sessionId}/{hash}.txt`; model gets `[ARTIFACT a3f9 132KB]` reference + 1KB preview. PathGuard write-path symlink protection. 19 tests.
- **TwoStageCompactor** (#2467 → #2481). At 65% context: cheap LLM-summarized checkpoint stored alongside live history. At 80%: hard compact (replace with summary + last 4 turns). Provider context size respected. Env-gated via `8GENT_TWO_STAGE_COMPACT`. 8 tests + 107 package suite green.

Model-agnostic routing:
- **PreToolRouter** (#2471 → #2480). Deterministic harness routing of retrieval strategy (AST / Grep / Glob / vector / FileRead / none) classified BEFORE the LLM is invoked. Heuristic-only, no LLM calls in the router. Helps weak local models (small Qwens, Gemma) by pre-fetching context. 14 tests.

Audit:
- **TurnJournal** (#2470 → #2482). Per-turn replayable JSON record at `~/.8gent/turns/{sessionId}/{turnIndex}.json`. System prompt hashed (sha256, not full text). Tool result previews capped at 1KB; full content lives in ArtifactStore. 13 tests.

### Closed without implementation
- **AgentDefinition consolidation** (#2468). Closed not-applicable. Our `packages/orchestration/subagent.ts` uses ad-hoc `SubAgentConfig` per spawn, not Anthropic-style named profile literals - there's nothing scattered to consolidate.
- **AnsiPainter renderer** (#2469). Filed as NOT-TO-BUILD strategic note. Owning the renderer would be a multi-month rewrite touching every TUI component; deferred until Ink limitations cost measurable user-visible UX.

### Process
- **Constitutional amendment** (#2475). Any multi-agent extraction, refactor, or feature touching MORE THAN 3 GitHub issues now requires boardroom alignment + signed PRD + minutes filed at `docs/boardroom-minutes/{date}-{slug}.md` BEFORE Wave 1 dispatch.
- **CleanRoomPort skill** at `~/.claude/skills/CleanRoomPort/SKILL.md`. AGPL-safe extraction discipline: no source copy, test-first, branch-from-origin-main, no TUI touches, no co-author trailers, sub-300 LOC per port, mandatory PR credit line.

### P0 follow-ups (filed during extraction, separate PRs)
- **#2473** Built-in slash command registry race on TUI startup (silent fallthrough). Restart fixes; code fix in this issue.
- **#2474** TUI frame buffer corruption (text from prior turns overlays new content). Splash → chat transition + per-turn frame-clear needed.

### Notes
- Wave 2 + Wave 3 used isolated git worktrees to prevent the working-tree collision Wave 1 hit (Karen's flag). Pattern documented for future multi-agent dispatches.
- Boardroom convened mid-flight on 2026-05-09. Minutes captured in `docs/boardroom-minutes/2026-05-09-openmonoagent-extraction.md` and cross-posted to 8gi-governance for cross-repo audit.

### Added (other)

- **Strict linting pipeline** (#2419). Tightened `biome.json` to flag `noExplicitAny`,
  `useImportType`, `noUnusedVariables`, `useTemplate`, `useArrowFunction`,
  `useOptionalChain`, `noControlCharactersInRegex`, `noDelete`, `useExponentiationOperator`,
  `useNumberNamespace`, `noUnusedTemplateLiteral`, `noUselessTernary` as warnings;
  promoted `useConst` to error. Existing violations stay visible as warnings (1100+) so
  the gate is unblocked while creating sustained pressure to fix them. New code with
  these issues will surface in PR review.
- **`bun run lint` rules-only script.** Split formatter/import-sort out of `lint` into
  separate `format` / `format:check` / `check` scripts so the lint gate is about code
  rules, not whitespace. New scripts: `lint:fix`, `format`, `format:check`, `check`,
  `check:fix`.
- **Pre-commit Biome hook.** `.pre-commit-config.yaml` runs `biome check --staged` on
  staged TS/TSX/JS/JSX/JSON files. Catches new errors at commit time without blocking
  on legacy warnings in untouched files.
- **Dedicated `lint.yml` CI workflow.** Runs on push to `main` and all PRs, with
  concurrency cancellation. `format:check` runs as advisory (non-blocking) until the
  large existing format diff is auditioned in a follow-up PR.
- **Ignored `.claude/` and `quarantine/`** in `biome.json` - those directories hold
  third-party skill artifacts and quarantined code, not first-party source.

### Notes

- `tsconfig.json` is already `strict: true`. `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` not enabled in this PR - both produce hundreds of
  errors across the existing codebase. Tracked for incremental adoption.
- "Agent-generated code linted before delivery" (acceptance item 4 of #2419) is
  out-of-scope here; that hook belongs in the daemon/agent loop and warrants a
  separate PR.

## [0.13.0] - 2026-04-30

### Added

- **Redesigned bottom bar** - full visual refresh of the TUI footer. New components:
  - `DjDeck` - premium audio deck (3-row LCD: track/elapsed, artist/duration, waveform/vol; reels inside the LCD; `Ctrl+P/N/B/M/↑↓` transport; `/dj close|open` toggle).
  - `AgentInstrumentStrip` - bordered status cards with stacked uppercase label / brighter value (MODEL · AGENTS · TOKENS · BRANCH · AGENT · MIC · APPROVAL · SESSION). Middle-truncation on long model names.
  - `ModeFooter` - bordered cyan-active mode chips. `Ctrl+Y` cycles modes.
  - `HeaderBar` - calm cyan brand pill (per-letter `8gent` colors) replacing the rainbow `Header`.
  - `BottomBar` - wraps the new stack so `app.tsx` holds one render call.
  - `theme.ts` + `typography.tsx` design-token foundation.
  Transient DJ feedback (`Now playing` / `Stopped` / `Paused`) suppressed at the chat call site.
- **Runtime capability grants** from skill manifests (#2104).
- **App archive format** + publish CLI (#2103).
- **Tool capability tiers** with granular permission gates (#2102).
- **App installer** with sandbox + lifecycle (#2101).
- **App creator** mini-app scaffolder with embedded skill iteration loop (#2100).
- **Typed harness/host contract** boundary for the runtime (#2099).
- **sqlite-vec** native vector search backing memory (#2098).
- **Thinking-level budget routing** with downgrade fallback in providers (#2097).
- **Workspace-shared SQLite** for cross-agent state persistence (#2096).
- **Realpath workspace boundary** enforcement in permissions (#2095).
- **tmux orchestration backend** + `term_*` agent tools (#2082).

### Changed

- `Ctrl+H` fancy-header toggle removed (rainbow header retired).
- `Ctrl+T` is now unambiguously "new tab" (previously also displayed alongside the mode hint).
- `Ctrl+Y` is the new mode-cycle hotkey (most single-letter Ctrl combos collide with TTY control codes).
- `^T:new ^W:close` rendered once in `HeaderBar` (was duplicated by `TabBar`).

### Removed

- `HudMusicPlayer`, `EnhancedStatusBar`, `StatusBar`, `DetailedStatusBar`, `ShortcutDock` no longer rendered (source files left intact in case any external surface still imports them).
- `AGENT_MODES` constant, `compactAgentModeBar`, `TUI_AGENT_MODE_COMPACT_BELOW`, `fancyHeader` state.

## [0.12.1] - 2026-04-29

### Added

- **`/spawn` auto-installs missing external agent CLIs.** When the binary for a preset (claude, codex, hermes, openclaw, aider, 8gent) is not on `$PATH`, `/spawn` runs the preset's install recipe (npm/pip), waits for it, re-checks, and only then opens the chat tab. Long output from the installer is suppressed to keep the chat clean. Force-reinstall via `/spawn <id> install`. (`apps/tui/src/lib/external-agent-runner.ts`, `apps/tui/src/app.tsx`)
- **`8gent update` command.** Runs `npm install -g @8gi-foundation/8gent-code@latest --force`. The `--force` flag fixes the recurring `EEXIST` error when stale `bin/8` / `bin/8gent` / `bin/8gent-code` symlinks block re-install on npm 9+. Streams npm output, prints a restart hint when done. (`bin/8gent.ts`)
- **`8gent permissions` command** (alias `8gent perms`). Diagnoses macOS Accessibility + Screen Recording grants for the host terminal. macOS attaches privacy permissions to the parent process (Terminal/iTerm/Warp/etc), not to bun, so the hands tools silently no-op when the terminal isn't trusted. The probe runs a tiny `osascript` AX query and a small `screencapture` (checks output bytes - denied permission writes a sub-2KB placeholder) to detect what's missing. With `--open`, also launches the relevant System Settings → Privacy panes. (`packages/hands/index.ts`, `bin/8gent.ts`)

## [0.11.14] - 2026-04-29

### Changed

- **Version + documentation sync.** No functional changes from 0.11.13. README badge bumped to 0.11.14 and CHANGELOG entries promoted from `Unreleased`. The `/spawn` auto-installer landed on `main` between this publish and the next; it ships in the following release.

## [0.11.13] - 2026-04-28

### Fixed

- **Intro music now fades out gradually instead of cutting abruptly** when the splash banner dismisses (any keypress OR auto-timeout) or when `/quiet` is run. afplay has no fade or seek support, so we delegate the fade to `ffplay` (ships with ffmpeg) using its `afade=t=out` filter - kills afplay, spawns ffplay starting at the same elapsed time with `volume=0.15,afade=t=out:st=0:d=2.4`, audio curves to silence over 2.4s. Falls back to abrupt cut if ffplay isn't on `$PATH`. (`apps/tui/src/components/IntroBanner.tsx`)

## [0.11.12] - 2026-04-28

### Added

- **Cinematic intro splash** with bundled launch instrumental. Splash schedule extended from 1300ms to 8500ms with typewriter slide-in for title, new subhead, and body line. Paces to a slow-building instrumental shipped at `apps/tui/sounds/launch.mp3` (auto-copied to `~/.8gent/sounds/launch.mp3` on first run; `ui.introSound` setting overrides). Volume 15% via `afplay -v 0.15` so the music sits under the splash text and any future narration.
- **HUD music player widget** above the status bar - track / progress / volume / hotkey hints. Polls `dj.status()` every 700ms; hidden when nothing's playing. Hotkeys (all `Ctrl+Shift+` to avoid clashing with chat input): `⌃⇧P` play/pause, `⌃⇧B` prev, `⌃⇧N` next, `⌃⇧↑↓` volume, `⌃⇧M` mute. (`apps/tui/src/components/HudMusicPlayer.tsx`)
- **`DJ.status()`** structured snapshot for any UI consumer (playing / paused / looping / title / position / duration / volume / queueSize). (`packages/music/dj.ts`)
- **`/quiet` slash command** (aliases: `mute`, `shut`, `silence`) - kills any in-flight intro music, prints a system message confirming the kill. Splash dismiss also calls it automatically.
- **TTS output on by default** via new `voice.outputEnabled` setting. Each agent's text reply is spoken through macOS `say` when the user is on darwin. Toggle live with `/voice on` / `/voice off`.
- **Per-tab TTS voices** via new `voice.perAgent` settings map. Defaults: Orchestrator → Daniel, Engineer → Karen, QA → Moira. Falls back to `voice.ttsVoice` when a role is missing. Editable from `/settings → Voice`. Helper: `getVoiceForRole(role, settings?)` exported from `@8gent/settings`.
- **`voice/per-agent-defaults` smoke test** asserts the helper resolves a non-empty voice for every role and respects fallbacks.
- **Dry-witted sarcastic option** for the onboarding communication-style question (option 1) - replaces a vanilla "professional" tone for users who want the sarcastic-motivational vibe.
- **SubscriptionControl skill** with Advisor / Copilot / Autopilot ladder for granular permission escalation.

### Fixed

- **Intro music now dies with the TUI under all exit paths.** Earlier versions used `{ detached: true }` + `proc.unref()` so afplay survived Ctrl+C, kill, and crashed sessions - only `pkill afplay` could stop it. Module-level child handle is tracked; `SIGINT` / `SIGTERM` / `exit` / `uncaughtException` hooks kill it; `detached` flag is gone.
- **Tab title reconciliation on every load** so renamed agents from settings.agents.names actually apply. Previously renaming agents during onboarding had no effect on the persisted tab titles (`apps/tui/src/hooks/useWorkspaceTabs.ts`).
- **Onboarding clarification questions no longer get cut off.** Single-line system messages that exceed the centered-hint budget soft-wrap into a multi-line block instead of being sliced at 60 chars (`apps/tui/src/components/message-list.tsx`).
- **Reasoning text no longer renders twice.** When a step finishes with no tool calls, its `event.text` IS the final assistant reply; we no longer also push it as a greyish system bubble in front of the cyan assistant bubble (`apps/tui/src/app.tsx`).

## [0.12.0] - 2026-04-28

### Changed

- **Lite mode is now the default.** Cold start drops from ~4.5s to ~2.4s on the same hardware. The agent answers turns the same way; what gets skipped on launch is:
  - AST indexing of the working directory (deferred to first AST tool call)
  - Convex session sync probe
  - Kernel training proxy `start()` (training itself was already opt-in via `~/.8gent/config.json`)
  - Heartbeat agents (git monitoring, self-heal, memory sync background loops)

  This aligns with Principle 2 ("free and local by default") and Principle 8 ("the work speaks for itself") - boot lean, layer features in only when the user asks for them.

### Added

- **`8GENT_FULL=1`** restores the old "everything on" behaviour for power users who depend on the heavies. Equivalent to the pre-0.12 default.
- **`8GENT_LITE=0`** also restores full mode (for symmetry with the previous flag direction).

### Migration

If you were relying on background sync, kernel training collection, or heartbeat self-heal:

```bash
export 8GENT_FULL=1     # or add to your shell rc
```

Otherwise no action needed - your sessions, agent, tools, and `/spawn` all keep working exactly as before.

## [0.11.2] - 2026-04-28

### Performance

- **8GENT_LITE=1 now actually disables the heavies.** When set, the Agent constructor:
  - Skips AST indexing (deferred to first AST tool call)
  - Skips kernel.start() (training proxy stays asleep)
  - Skips Convex session sync probe
  - Skips heartbeat agent loops (git monitoring, self-heal, memory sync)
  - Already skips the intro banner (from v0.11.1)

  Measured Agent ctor cost on this host (qwen3.6:27b config):
  - Normal: **~4.5s** (3 trials: 4864/4444/4532ms)
  - LITE=1: **~2.4s** (3 trials: 2433/2414/2478ms)
  - **47% reduction** in Agent construction time.

  The agent still answers turns in lite mode - it just won't sync, learn, or self-heal until you remove the flag. Inspired by jcode's "lean by default" philosophy.

## [0.11.1] - 2026-04-28

### Performance

- **Faster cold start.** Removed dead `PlanValidateLoop` construction from the `Agent` constructor - the field was assigned but never invoked at runtime, only referenced in a comment. Saves an import chain (tree-sitter + 3 sub-modules) and ~50ms per Agent instantiation.
- **Trimmed intro banner.** Total reveal cut from 1900ms to 1300ms (-31%) for snappier launch. The cascade still feels intentional, just less of a wait.
- **8GENT_LITE=1 env flag.** Skips the intro banner entirely. Reserved for future lazy-init of auxiliary subsystems (kernel, heartbeat, sessionSync) inspired by jcode's lean-by-default philosophy. v0.11.1 wires the flag; v0.12.0 will lazy-init the heavies.

### Notes

- jcode (Rust) hits ~28 MB RAM and sub-100ms cold start because it ships native binaries with no V8/Bun bootstrap. 8gent-code on Bun has a structural floor around 100ms, but there's still a lot of fat we can trim before claiming we're done.

## [0.11.0] - 2026-04-28

### Added

- **Deterministic provider failover on any error** (#1959) - `Agent.chat` now walks the failover chain (`packages/providers/failover.ts`) on Bad Request / 5xx / network / schema / timeout instead of dying. Inner 429 backoff preserved. Hard cap 6 providers, 4 rate-limit attempts. ESC propagates. Exhausted chain throws one composite error listing each attempted provider.
- **Hands wired to AI SDK** (#1961) - 9 desktop tools now reachable from the TUI agent: `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_press`, `desktop_scroll`, `desktop_drag`, `desktop_hover`, `desktop_windows`, `desktop_clipboard`. Each delegates to `packages/computer/bridge.ts` so security caps stay in one place. Also extended `CORE_TOOLS` so local providers (LM Studio, Ollama) ship hands too.
- **Auto skill creation - the agent can author its own SKILL.md** (#1963) - new `propose_skill_creation` AI SDK tool + `packages/self-autonomy/skill-creator.ts`. Agent decides when a recurring pattern is worth capturing, writes `packages/skills/<name>/SKILL.md`, logs to `~/.8gent/auto-created-skills.jsonl` with exact revert command. Hard cap 3 per session, name-collision guard, path-traversal blocked.
- **8TO real-agent MVP** (#1965) - new `packages/board-vessel/agent-runner.ts` exposing `runOfficerAgent({code, task})` that uses the real `runAgent` from `packages/ai` with the AI SDK tool registry. Job-spec system prompt with explicit acceptance criteria + prohibited words ("visionary", "empower", "strategic alignment"). Local CLI `bun scripts/run-officer.ts 8TO "<task>"` for testing.
- **Per-tab agent models + 3/3 inference indicator** (#1967, #1973) - each chat tab is backed by a different inference engine. Orchestrator/Ollama qwen3.6:27b, Engineer/LM Studio gemma-4-26b-a4b, QA/apfel apple-foundationmodel. Status bar `X/Y agents` slot now driven by a live HTTP probe (apfel /health, LM Studio /v1/models, Ollama /api/tags), refreshed every 8s.
- **CLI model test harness** (#1969) - `bun run test:models` and `bun run test:models:providers` smoke each role's provider+model with a single prompt and report a pass/fail table. Exits non-zero so regressions in role-registry edits surface immediately.
- **apfel as a TUI provider** (#1971, #1973) - Apple Foundation Model via Arthur-Ficial's `apfel` (https://github.com/Arthur-Ficial/apfel) is now a first-class AI SDK provider. Default base URL `http://localhost:11500/v1` (override `APFEL_BASE_URL`), token via `APFEL_TOKEN`. Model-loader fetches `/v1/models` instead of falling through to a placeholder.
- **/spawn external agent CLIs as nested tabs** (#1975) - 8gent becomes a meta-orchestrator. `/spawn claude` / `/spawn codex` / `/spawn hermes` / `/spawn openclaw` / `/spawn aider` / `/spawn 8gent` opens a chat tab whose backing brain is the named CLI. Each turn spawns the CLI with the prompt + history; stdout becomes the assistant message. Auth is delegated to each CLI's own login flow - 8gent stays auth-free.
- **/spawn 8gent for nested self-orchestration** (#1976) - the bidirectional half. 8gent's own `chat` and `run` subcommands are pipe-friendly, so `/spawn 8gent` runs a sibling 8gent worker as a sub-agent in another tab.
- **Animated intro banner** (#1973) - 8GENT block-letter wordmark in brand amber. Cascade reveal over ~1900ms: wordmark → flourish line with ∞ → "The Infinite Gentleman" title → "free. local. eight powers. no caps." subtitle → hold → fade-out. Skippable any-key, opt-out `8GENT_NO_INTRO=1`.
- **TouchDesigner skill** (#1996) - new `packages/skills/touchdesigner/SKILL.md` teaching the agent to drive Derivative TouchDesigner via OSC, Web Server DAT, or the `td` Python module. Covers audio-reactive scenes, MIDI-triggered particle bursts, projection mapping, MIDI controller surfaces, and a verification recipe for "is TD reachable from this script?"
- **Telegram multi-step task surface** (#1906, #1913) - the @eaborobot bot now runs multi-tool agent plans behind a single live-edited progress message instead of blocking single-shot prompts. New modules under `packages/telegram-bot/`: `task-runner` (lifecycle), `mobile-formatter` (concise tool summaries + chunking), `file-sender` (`sendDocument`/`sendPhoto` for screenshots and code files), `keyboards` (Cancel / Retry / Continue / Approve), `session-store` (per-chat persistence at `~/.8gent/telegram-sessions.json`), `daemon-client` (WebSocket wrapper with reconnect), and `bridge-adapter` (event glue). `packages/daemon/telegram-bridge.ts` opts into the new path by default; set `EIGHT_TG_LEGACY=1` to fall back. New `/cancel` command stops the in-flight task. 38 unit tests covering the 5-step end-to-end flow with a fake socket. See `docs/specs/TELEGRAM-MULTISTEP.md`.

### Fixed

- **Final CJK comment cleanup in `packages/tools/option.ts`** - leftover `the值` in a JSDoc comment for `None.flatMap()`, last trace of the merge corruption that #1893 cleaned up in identifiers. `bun run typecheck` and `bun test packages/ apps/` (243 + 16 pass, 0 fail) confirm the repo-health work tracked in #1883 is complete.
- **CI test suite green** - scoped `bun test` to `packages/` and `apps/` only, excluding `benchmarks/` autoresearch-loop validators that depend on dynamically-generated code in `benchmarks/autoresearch/work/` (which only exists at benchmark runtime, not in CI). Restored 241 pass / 10 skip / 0 fail from 243 pass / 21 skip / 439 fail / 16 errors. Added `test:benchmarks` script for running them explicitly when the work dir is populated. CI uses `bun run test` to honor the package.json scope.
- **Corrupted identifiers in `packages/tools/`** - `structured-log.ts` referenced `this.current位` (CJK garbage from a bad merge) instead of `this.currentLevel`. `test-runner.ts` returned `total意图` instead of `totalDuration`. Both were causing `tsc --noEmit` to fail on main, blocking CI on every open PR. First payment toward the broader typecheck cleanup tracked in #1816.

### Added

- **8gent Computer Phase 3 cua loop** - perceive → recall → decide → act loop at `packages/eight/loops/computer-use.ts` with channel-aware failover (default vision/tool tier = Qwen 3.6-27B), accessibility-tree-first perception (`packages/eight/perception/tree.ts`) with screenshot escalation (`packages/eight/perception/screenshot.ts`), Qwen-tuned vision prompt template (`packages/eight/prompts/computer-use-vision.ts`) with graceful no-vision fallback for the heavy cloud tier, system prompt at `packages/eight/prompts/computer-use-system.ts`, AppKit-based AX tree query (`packages/daemon/tools/accessibility-tree.ts` + Swift CLI helper at `apps/8gent-computer/Sources/AccessibilityTreeCLI/main.swift`) replacing the Phase 1 stub, and an 8-task headless smoke suite (`packages/eight/scripts/computer-use-suite.ts`) that runs in CI on every PR. NemoClaw policy gate preserved on the production hands path (#1864, #1865, #1866, #1867, #1882)
- **8gent Computer Phase 2 scaffold** - new `apps/8gent-computer/` Swift package. NSApplication accessory shell, Cmd+Opt+Space global hotkey via NSEvent monitors (no Accessibility prompt), glass NSPanel anchored 80px from the bottom, static AudioWaveView placeholder, headless CLI `--headless --intent "..."` emitting structured JSON. macOS CI job builds the Swift target and runs the headless smoke (#1857, #1858, #1859)
- **8gent Computer Phase 2.4-2.7 voice round-trip** - on-device `SFSpeechRecognizer` streaming captions with mic + speech permission (`SpeechCapture.swift`), `URLSessionWebSocketTask` client connecting to the daemon `/computer` route with reconnect + exponential backoff (`DaemonClient.swift`), `AVSpeechSynthesizer` sentence-buffered TTS with hotkey-press interrupt (`SpeechReply.swift`), daemon protocol v1 wire types (`Models/Event.swift`), in-panel approval sheet for NemoClaw prompts, real `HeadlessMode.swift` that connects to the daemon and emits NDJSON token/tool/done events on stdout, mock daemon (`scripts/mock-daemon.ts`) used by the macOS CI swift smoke job (#1860, #1861, #1862, #1863)
- **Grove consent ceremony copy draft** - 3-screen plain-English consent flow (What you share / What you receive / Confirm). Reading grade 9, no em-dashes, no purple/pink/violet, default-decline, signed local-only acknowledgement schema (#1568)
- **8gent Computer Phase 4 trace capture** - new `packages/memory/computer-use-traces.ts` API with `startTrace`, `appendStep`, `closeTrace`, `getTrace`, `listRecent`, `purgeOlderThan`, backed by SQLite migration `001-traces.sql` (tables `computer_use_traces` + `computer_use_trace_steps`, FK cascade, ordered step indexing). Screenshots written to `~/Library/Application Support/8gent/traces/<sessionId>/<step>.png`; rows hold the path. Local-only in v0, no sync. Headless smoke at `packages/memory/scripts/smoke-trace-capture.ts`. Trace viewer CLI at `packages/memory/scripts/traces.ts` with `list`, `show`, `replay` (protocol-version-1 NDJSON), and `purge --older-than` (#1868, #1869)

---

## [0.3.0] - 2026-04-11

### Added

#### Harness Architecture
- **Brain/hands isolation** - immutable JSONL audit logging, session file permission restrictions (#1410)
- **Context compression** - proactive token threshold compression for long sessions (#1413, #1405)
- **Sub-agent spawn protocol** - formal spawn protocol with governance hooks (#1411, #1406)
- **Skill compounding** - completed tasks automatically become reusable skills (#1412, #1407)

#### Voice
- **KittenTTS neural voices** - 8 local neural TTS voices (Bella, Jasper, Luna, Bruno, Rosie, Hugo, Kiki, Leo) via KittenML/kitten-tts-nano-0.8. Free, no API key, runs on CPU
- **Voice onboarding** - new onboarding step auto-detects Python/KittenTTS, offers one-click install, interactive voice picker. Bruno is the default voice
- **Full-duplex provider** - `FullDuplexProvider` interface with machine-aware backend detector in @8gent/voice (#1252)
- **MoshiMLXProvider** - full-duplex voice backend for Apple Silicon via Moshi/Kyutai (#1253)

#### Orchestration
- **RoleRegistry** - role-based runner configs in `@8gent/orchestration` (#1294)
- **TaskDispatcher** - atomic task dispatch with claimed map + state machine (#1279)
- **HyperAgent pipeline** - extracted sequential pipeline into @8gent/orchestration (#1251)
- **Terminal tabs** - node-pty based terminal tab support (#1276)

#### TUI
- **Skills loader** - TUI loads skills from bundled `packages/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`. Supports triggers, aliases, and `/alias` resolution
- **Skill slash commands** - unknown `/commands` resolve to loaded skills automatically. Ghost completions include all skill triggers
- **Crash-resilient sessions** - session persistence with resume on crash (#1175)

#### Infrastructure
- **Cloud vessel deployment** - dual inference mode for cloud-hosted vessels (#1161)
- **Adaptive sequential pipeline** - Run D multi-inference pipeline (#1159)
- **Entity dedup** - UNIQUE(type, name) constraint for entity deduplication (#1369, #1382)
- **Zod to JSON Schema** - generation pipeline for schema drift prevention (#1370)

### Fixed
- **TUI layout** - 5 layout constraint fixes: status verb row, agent mode bar overflow, flexShrink on chrome, ProcessDetailView height, horizontal chrome columns (#1295-#1300)
- **TUI CLI** - `--provider=`, `--model=`, `--yes` flag parsing. Implicit `tui` subcommand when first token is a flag
- **TUI narrow terminals** - compact single-line status bar under 92 columns, scaled sidebar width
- **TUI model picker** - fixed invisible cursor on Solarized themes, scroll init, empty model filtering
- **Destructive prompt mutations** - disabled to prevent unintended prompt changes (#1129)
- Array.from() for Map iterators in harness module

### Security
- Session file permissions restricted, vault sentinels redacted
- YAML frontmatter sanitized in skill compounding
- Command injection, path traversal, prototype pollution fixed in spawn protocol

### Changed
- **Repository scope** - governance docs moved to `8gi-governance`, media assets to `8gent-world`. This repo is kernel-only
- **TUI animations** - `^A` toggle now fully disables/enables all motion
- **TUI status bar** - plain telemetry labels, "ready (awaiting input)" instead of "Done"

---

## [2.0.1] - 2026-03-25

### Fixed
- **Double shebang bug** - Build output had `#!/usr/bin/env bun` prepended twice, breaking execution on Linux. Now checks if shebang exists before prepending. This fix is critical for all Linux users and Docker-based benchmarks.
- **Cross-platform build script** - Replaced macOS-only `sed -i ''` with cross-platform Node one-liner.
- **CI workflows** - Added version sync check, secrets scan, policy engine integrity test to CI. Release workflow now auto-publishes to npm.
- **Harbor adapter** - Fixed AgentContext API (pydantic data model, not message store). Added robust Bun + 8gent installation in Docker containers.

### Added
- **Terminal-Bench Harbor adapter** (`benchmarks/harbor_adapter/`) - Runs 8gent through Terminal-Bench 2.0 via Harbor framework. Oracle baseline validated at 80%.
- **Ollama timeout increase** - 5 minute timeout for 14B model pulls.

---

## [2.0.0] - 2026-03-25

### Added
- **Computer Use - Power #10** (`packages/computer/`) - Desktop automation via usecomputer bridge. Screenshot, click, type, press, scroll, drag, hover, clipboard, window list. Security-gated with point validation, max limits, dangerous key detection.
- **Process Manager** (`packages/computer/process-manager.ts`) - Process listing with memory/CPU, graceful/force quit, safe list, system-critical protection (22 blocked processes), suggest quittable apps.
- **13 desktop tools** in ToolExecutor - `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_press`, `desktop_scroll`, `desktop_drag`, `desktop_hover`, `desktop_windows`, `desktop_clipboard`, `desktop_processes`, `desktop_quit_app`, `desktop_suggest_quit`, `desktop_safe_list`.
- **Running Apps menu** in Lil Eight's macOS menu bar - memory stats, per-app quit/force-quit dialogs, Quit All Non-Essential, protected app list.
- **CLUI tray upgrade** (`apps/clui/src-tauri/src/lib.rs`) - Daemon status, session count, Resource Manager submenu, Settings submenu with daemon control, log viewer, config access.
- **AGENTS.md** - Universal agent instructions for any AI coding harness (Pi, Hermes, OpenCode, Aider, Goose, Cline, Continue, SWE-Agent).
- **NemoClaw desktop policies** - Desktop automation policy rules: read-only ops allowed, mutations require approval, dangerous key combos (cmd+q, alt+f4) hard-blocked.

### Changed
- **README.md** - Added usecomputer and Quitty to inspirations. Fixed Hermes credit to NousResearch (was incorrectly ArcadeAI).

### Removed
- **60+ quarantined tool files** - Cleaned up unused utility packages and their quarantine docs. All recoverable from git history.

---

## [1.0.0] - 2026-03-22

### Added
- **Daemon Protocol** (`docs/DAEMON-PROTOCOL.md`) - WebSocket protocol specification for external clients (8gent.app, 8gent OS, Telegram). Defines connection handshake, auth, session lifecycle, prompt/response streaming, cron management, and health checks. The contract between the brain and the interfaces.
- **BRAND.md** - Canonical brand reference copied from 8gent-world. Typography (Fraunces/Inter/JetBrains Mono), color palette, domain table.
- **Changesets** - Added @changesets/cli for monorepo version management across 40+ packages.
- **Daemon gateway expansion** (`packages/daemon/gateway.ts`) - New WebSocket message types: `sessions:list`, `cron:list`, `cron:add`, `cron:remove`, `health`. External clients can now manage cron jobs and query daemon state.
- **Session state persistence** (`packages/daemon/index.ts`) - Saves active session metadata to `~/.8gent/daemon-state.json` on graceful shutdown. Clients can resume sessions after daemon restart.
- **Idle session cleanup** (`packages/daemon/agent-pool.ts`) - Sessions idle for 30+ minutes are automatically evicted. Cleanup runs every 5 minutes.

### Fixed
- **Daemon log overwrite bug** (`packages/daemon/index.ts`) - `Bun.write()` was overwriting the log file on every event instead of appending. Switched to `appendFileSync()`.
- **Ecosystem references** - CLAUDE.md and README.md now reference 8gent.dev as canonical domain and link to all ecosystem products (8gentos.com, 8gent.app, 8gentjr.com, 8gent.world, 8gent.games).

### Changed
- **CLAUDE.md** - Added ecosystem table and reference to BRAND.md. 8gent Code positioned as "the brain" and free on-ramp to 8gent OS.

- **Security** (`packages/validation/security-scanner.ts`, `secret-patterns.ts`) - Static security scanner: detects leaked secrets (API keys, AWS credentials, DB connection strings, JWTs, private keys) and vulnerability patterns (eval injection, SQL concat, innerHTML XSS). `scanFile`, `scanContent`, `scanDirectory` API. Pre-commit gate via `hasCriticalFindings`. Credit: [0din-ai/ai-scanner](https://github.com/0din-ai/ai-scanner) for pattern taxonomy.
- **Ability Scorecards** (`packages/validation/ability-scorecard.ts`) - Measurable metrics per ability: memory recall accuracy, worktree parallelization efficiency, policy violation rate, evolution improvement delta, healing recovery rate, entrepreneurship hit rate, AST blast radius accuracy, browser research relevance. JSONL persistence per session, baseline comparison.
- **Meta-Optimizer** (`benchmarks/autoresearch/meta-optimizer.ts`) - Optimizes beyond system prompt: mutates few-shot examples, model routing priority, grading weights (exec/keyword split), and temperature sweep. Heuristic suggestions based on what worked per category. Inspired by Karpathy's program.md meta-optimization concept.
- **Macro Action Decomposer** (`packages/orchestration/macro-actions.ts`) - Coarse-grained task delegation: topological sort on dependencies, parallel group detection, critical path analysis, speedup estimation. Kahn's algorithm for wave-based parallelization.
- **Actuator Tools** (`packages/tools/actuators/`) - Write actuators for the physical/digital world: deploy (Vercel, Railway, Fly.io), publish (npm, git tag, GitHub release), notify (Telegram, GitHub issues). Dry-run by default. All actions return undo commands where reversible.
- **Token Throughput Tracker** (`packages/orchestration/throughput-tracker.ts`) - Global tokens/sec metric across all parallel agents. Sliding window snapshots, daily reports, per-agent utilization, model and category breakdowns. JSONL persistence with 7-day retention.
- **Curriculum Skills** (`packages/eight/curriculum.ts`) - Teachable curricula with step progression, exercises, and comprehension checks. Built-in: "8gent-architecture" (5 steps) and "writing-benchmarks" (4 steps). `CurriculumRunner` generates teaching prompts.
- **Persona Mutation** (`packages/self-autonomy/persona-mutation.ts`) - Auto-tune SOUL.md calibration table from accumulated user feedback. Parses current persona parameters, records up/down feedback with evidence, suggests mutations (each feedback = +/-5, clamped 0-100). Never writes to SOUL.md directly (safety constraint).
- **Telegram Unified Portal** (`packages/telegram-bot/unified-portal.ts`) - Single portal to all automation: `/status`, `/agents`, `/benchmark`, `/deploy`, `/throughput`, `/scorecard`, `/soul`, `/help`. Auth gating, inline keyboards, auto-split for long messages. Stub handlers document integration points.

## [0.8.0] - 2026-03-21

### Added

#### Eight Core Abilities (8 new packages)
- **Memory** (`packages/memory/`) - SQLite + FTS5 persistent recall with Ollama embeddings, 30-day decay, frequency-based promotion via `PromotionManager`, semantic search via `SemanticRecall`
- **Worktree** (`packages/orchestration/`) - `WorktreePool` for multi-agent parallel execution via git worktrees, max 4 concurrent agents, filesystem-based inter-agent messaging
- **Policy** (`packages/permissions/`) - YAML-driven policy engine with 11 default rules, approval gates for destructive operations, privacy-aware model routing
- **Evolution** (`packages/self-autonomy/`) - Post-session reflection, Bayesian skill confidence scoring, self-improvement SQLite database, learns from successes and failures
- **Healing** (`packages/validation/`) - Hypothesis Loop pattern: checkpoint-action-verify-revert. Git-stash atomic snapshots, failure log (`~/.8gent/healing/failures.jsonl`), configurable retry limits
- **Entrepreneurship** (`packages/proactive/`) - GitHub bounty and help-wanted issue scanner, capability matcher, opportunity pipeline with full lifecycle tracking
- **AST** (`packages/ast-index/`) - Blast Radius Engine: import dependency graph, test file mapping, change impact estimation before any edit
- **Browser** (`packages/tools/browser/`) - Lightweight web access via fetch + DuckDuckGo HTML scraping, disk cache, no headless browser dependencies

#### Voice Chat Mode
- **`/voice chat`** - Half-duplex voice conversation loop: listen -> transcribe -> agent -> speak -> listen
- Sox-based recording with built-in silence detection (auto-stops when you stop talking)
- Local transcription via whisper.cpp, OpenAI Whisper cloud fallback
- macOS TTS via `say` command with sentence-chunked delivery for natural speech
- ESC interrupts agent mid-speech, status bar shows VOICE CHAT / SPEAKING / THINKING states
- `VoiceChatLoop` class (`packages/voice/voice-chat.ts`), `useVoiceChat` React hook

#### TUI Overhaul
- **Neumorphic folder tabs** - Chat, Notes, Ideas, BTW, Questions, Music workspace tabs
- **Activity monitor** - Real tool-call feed replacing decorative spinner
- **Responsive chat bubbles** - Terminal-width-aware indent (10%, capped at 12 cols)
- **Folder frame** - Vertical borders on content area
- **ADHD mode** - Bionic text boldening + ACE-Step LoFi music generation

#### Infrastructure
- **SOUL.md** - Agent persona definition: "The Infinite Gentleman" identity, voice calibration, 11 principles, anti-patterns, heartbeat system, daily schedule
- **GitHub integration** - Token management (Keychain/encrypted), REST API helpers, `/github` slash command, `gh` CLI auto-config
- **Ability showcase benchmark** - Single task exercising all 8 abilities end-to-end
- **Long-horizon benchmarks** (LH001-LH005) - Review bot, migration, scheduler, API gateway, CLI framework
- **Competition infrastructure** - `overnight-competition.ts`, `overnight-orchestrator.sh`, `sync-results.ts`
- **Tenant Convex persistence** - `tenants` table with CRUD mutations, in-memory fallback
- **Session sync** - `SessionSyncManager` batches token/tool-call deltas, flushes every 10s
- **Real Stripe billing** - Real SDK calls, webhook verification, Hono+Express handlers, lazy init
- **Knowledge graph** - SQLite entity/relationship store with BFS traversal, heuristic extraction
- **Memory v2** - SQLite+FTS5+embeddings replacing JSONL, 5 memory types, hybrid search, version history

### Fixed
- **Voice TUI freeze** - Replaced blocking `while(running)` with non-blocking `setTimeout` scheduler; fixed `useInput` consuming all keyboard input
- **Recording never stopping** - VoiceEngine audio levels were simulated (random numbers); switched to sox native silence detection
- **Duplicate voice messages** - Voice hook and agent.chat() both adding messages to state
- **[_EOT_] tokens in display** - Strip qwen3.5 end-of-turn markers from transcript, display, and TTS
- **Chat bubbles disappearing** - `useStdout()` called conditionally, violating React hook rules; moved to top of component
- **Voice messages not showing** - `agent.chat()` doesn't update React state; added explicit `setMessages()` calls
- **Text overlap in message list** - Hardcoded `marginLeft={20}` replaced with responsive terminal-width-based indent
- **Security** - Removed all hardcoded Telegram tokens, moved to .env

## [0.7.0] - 2026-03-18

### Added
- **Smart onboarding** - auto-detects git config, Ollama models, GitHub auth; reduces from 8 questions to 3
- **Preferences cloud sync** - `PreferencesSyncManager` pulls/pushes preferences via Convex after auth; `updatedAt` wins merge strategy
- **Adaptive system prompt** - `USER_CONTEXT_SEGMENT` injects user name, role, communication style into system prompt
- **Session history & resume** - `/history`, `/continue`, `/resume`, `/compact` slash commands; checkpoints every 5 messages
- **Conversations table** - Convex schema for cross-device session persistence with checkpoint data
- **Personal LoRA collector** - `PersonalCollector` quality-filters session traces for fine-tuning (score >= 0.7, no corrections)
- **ESC to interrupt** - pressing Escape during generation aborts the AI SDK stream immediately
- **User-scoped memory** - `userId` field on `MemoryBase` and `SearchOptions` for per-user memory recall
- **HistoryScreen** - TUI screen for browsing and resuming past sessions with keyboard navigation
- **Comprehensive personalization docs** - `docs/PERSONALIZATION.md` covering all 5 phases

## [0.6.0] - 2026-03-17

### Added
- **`apps/clui/` - Tauri 2.0 desktop overlay** - branded 8gent desktop app with Alt+Space toggle, multi-tab sessions, transparent floating overlay, Rust backend for process management, React 19 frontend with Tailwind CSS 4, real-time NDJSON streaming from agent subprocess, permission server for human-in-the-loop tool approval
- **`packages/auth/` - Clerk authentication** - device code flow for CLI login (`8gent auth login`), macOS Keychain token storage with AES-256-GCM encrypted file fallback, JWT validation via `jose`, automatic token refresh, non-blocking anonymous mode (auth never blocks local usage)
- **`packages/db/` - Convex database** - reactive database with users, sessions, usage, and preferences tables; real-time sync; Clerk auth integration; offline mutation queuing; ConvexClient wrapper for Bun
- **`packages/voice/` - Speech-to-Text via Whisper** - local transcription via whisper.cpp CLI (no cloud dependency), sox-based mic recording, model manager with streaming downloads from Hugging Face (tiny/base/small), voice activity detection, OpenAI Whisper API cloud fallback, VoiceEngine with EventEmitter API
- **`packages/control-plane/` - Multi-tenant management** - tenant provisioning with subdomain routing (username.8gent.app), usage analytics, billing plan definitions (free/pro/team), Stripe integration stubs, admin dashboard data layer
- **`apps/dashboard/` - Admin dashboard** - Next.js 16 admin panel with Clerk auth + RBAC, user management with search/filter, session monitoring, usage charts (recharts), system health, model distribution, plan management
- **CLUI integration components** - ThinkingView, EvidencePanel, PlanKanban, AuthGate, SettingsPanel adapted from TUI to React DOM with Framer Motion animations
- **TUI voice components** - `useVoiceInput` hook (Ctrl+Space toggle) and `VoiceIndicator` component with recording status, audio levels, and download progress
- **CLI auth commands** - `8gent auth login`, `8gent auth logout`, `8gent auth status`, `8gent auth whoami`
- **20 BMAD planning documents** - project briefs, PRDs, architecture docs, and epics for all 5 phases across `docs/bmad/`
- **Local vision & OCR model support** - vision router now auto-discovers OCR-specialized models (dots.ocr, deepseek-ocr, glm-ocr) alongside general vision models (qwen2.5-vl, minicpm-v, internvl2)
- **`/vision` slash command** - configure vision/OCR models from TUI: `/vision status`, `/vision model <name>`, `/vision ocr <name>`, `/vision pull` for recommendations
- **Vision config in `.8gent/config.json`** - user-configurable `defaultModel`, `ocrModel`, fallback chains, provider preference (local/cloud), timeout
- **OCR-specific routing** - `findOCRModel()` prefers dedicated OCR models for text extraction, falls back to general vision models with strong OCR
- **OCR prompt in VisionInterpreter** - dedicated OCR prompt preserves formatting, tables, code indentation, and LaTeX formulas
- **OpenRouter free vision fallback** - vision router now checks OpenRouter free models even without API key as additional fallback

### Fixed
- **Installer color violations** - replaced forbidden `color="gray"` and `color="white"` with `dimColor` and default text in `apps/installer/src/index.tsx`
- **write_file path bug** - models sometimes pass absolute-looking paths like `/8gent-code/server.ts` that resolve outside the working directory; these are now auto-stripped to relative paths instead of throwing a path-traversal error; tool description and system prompt updated to instruct models to use relative paths

### Added
- **Dynamic free model router** - `getBestFreeModel()` in `packages/providers/index.ts` queries OpenRouter's `/api/v1/models` endpoint to find the best available free model (filtered by `:free` suffix, sorted by context length); results cached for 1 hour; `spawn_agent` now accepts `model: "auto:free"` to automatically pick the best free model
- **Evidence collection visible in TUI** - real-time evidence badges (pass/fail) appear in the chat stream after write_file, edit_file, run_command, and git_commit; one-line summary shown at end of each response; `/evidence` command shows full session breakdown with per-type counts
- **Three-layer model architecture** - base model (qwen3) + Eight LoRA (centralized training from benchmarks) + Personal LoRA (user's local fine-tune on their patterns); personal module retrains when a new Eight version releases
- **Eight model version manager** (`version-manager.ts`) - manages model promotion lifecycle with naming convention `eight-{major.minor.patch}-q{gen}:{params}`, Gemini Flash judge validates checkpoints before promotion
- **8gent as default provider** - `eight-1.0-q3:14b` is now the primary recommended model across all documentation and quick-start guides
- **Auto-open files on macOS** - files referenced in agent output are opened automatically in the default editor
- **TUI accepts any model name** - `/model` command now accepts arbitrary model identifiers, not just predefined options

### Fixed
- **Security fixes ported to `packages/eight`** - hardened command execution, input sanitization, and permission checks carried over from agent package

### Added (prior)
- **`@8gent/kernel` package** - full 4-phase RL fine-tuning pipeline via training proxy
  - **Phase 1: Proxy manager** (`proxy.ts`) - start/stop training proxy, health checks, latency overhead monitoring with configurable threshold
  - **Phase 2: Judge scoring** (`judge.ts`) - PRM wiring via Gemini Flash (free), score distribution tracking, per-model stats, daily trend analysis
  - **Phase 3: Training orchestration** (`training.ts`) - GRPO batch collection with score filtering, checkpoint creation, benchmark validation gate, auto-rollback on regression
  - **Phase 4: Production loop** (`loop.ts`) - MadMax scheduling (sleep/idle windows), auto-promotion of improved checkpoints into model-router, health monitoring, score trend alerts
  - **Kernel manager** (`manager.ts`) - unified entry point, reads `.8gent/config.json`, safe no-op when disabled
- **RL fine-tuning exploration** - architecture doc, proxy config, and integration plan for continuous GRPO fine-tuning of local Ollama models via training proxy
- **Training proxy toggle** - `TRAINING_PROXY_URL` env var and `.8gent/config.json` training_proxy section to route Ollama calls through the OpenAI-compatible training proxy
- **RL checkpoint validation gate** - `benchmarks/autoresearch/validate-checkpoint.ts` runs benchmark suite against fine-tuned models and compares against baseline scores to prevent regressions
- **Kernel Fine-Tuning section in README** - documents proxy architecture, base model recommendations, and how to enable
- **Remotion video demos** (`apps/demos/`) - React-based video generation for product reels and landing page content
  - 3 ready-to-render compositions: HeroIntro, FeatureShowcase, CostComparison
  - 9:16 vertical (reels) and 16:9 landscape variants for each
  - Reusable component library: Logo, TerminalWindow, GlowCard, CodeBlock, Background
  - Animation utilities: fade-in, scale-in, typewriter, glow pulse, counter
  - Branded design tokens matching 8gent visual identity
  - Scripts: `studio`, `render:hero`, `render:features`, `render:cost`, `render:all`
  - **Media preview page** (`bun run demos:media`) - Vite-powered browser preview with Remotion Player

## [0.5.0] - 2026-03-14

### Added
- **Universal BMAD planning** - system prompt now classifies tasks as Code, Creative, Research, Planning, or Communication with tailored approaches for each
- **Proactive planner wired into agent loop** - updates prediction context on every tool call, tracks modified files and errors
- **Evidence collection in agent core** - fire-and-forget evidence gathering after file writes, commands, and git commits; session summary on finish
- **AST `indexFolder()` implementation** - recursively parses TS/JS files, populates symbol maps and file outlines
- **AST `getSymbolSource()` implementation** - reads file and extracts lines for a specific symbol with optional context
- **AST `estimateTokenSavings()` implementation** - calculates full-file vs symbol-only token estimates
- **Momentum tracking** in ProactivePlanner - tracks steps completed, rate (steps/min), and streak
- **Universal step categories** - added `creative`, `research`, `communication`, `planning` to StepCategory
- **Creative/research prediction methods** - `predictCreativeSteps()` and `predictResearchSteps()` for non-code tasks
- **REPL commands**: `/board` (kanban view), `/predict` (confidence-scored predictions), `/momentum` (velocity stats)
- **bmad-method** as devDependency (v6.1.0) with auto-init on postinstall

### Fixed
- `EvidenceCollector` constructor now accepts optional config with `process.cwd()` default (was required, crashed without args)
- `PredictionContext.currentPlan` type inlined (was referencing undefined `ExecutionPlan`)
- `indexRepo()` now throws descriptive error instead of generic "Not implemented"
- Removed `...config` spread in EvidenceCollector that was overwriting defaults

### Changed
- Version bump to 0.5.0 (new features: BMAD wiring, evidence, AST, momentum)

---

## [0.3.1] - 2026-03-14

### Added
- Agent mode cycling (Ctrl+T): Planning, Researching, Implementing, Testing, Debugging
- Kanban auto-population from agent PLAN: output - parses numbered steps into cards
- Kanban auto-advancement: Ready → In Progress on tool start, → Done on tool end
- Dynamic model fetching per provider (Ollama, OpenRouter, LM Studio)

### Fixed
- ADHD mode toggle (stale closure - only toggled on, never off)
- Scroll jumping - removed overflow:hidden, capped visible messages to 50
- Re-planning loop - agent now plans once then executes immediately
- Replaced "Demoing" mode with "Debugging"

---

## [0.3.0] - 2026-03-14

### Added
- **packages/eight/** - New core agent engine (replaces packages/agent/)
  - Non-blocking agent with always-visible input and message queue
  - Real-time streaming of assistant reasoning into chat
  - Ollama, LM Studio, and OpenRouter client modules
  - Context engineering and prompt system
  - Full REPL with tool loop
- **packages/ai/** - Vercel AI SDK integration
  - ToolLoopAgent with multi-turn conversation support
  - Provider abstraction (Ollama, OpenRouter, LM Studio)
  - Toolshed bridge for dynamic tool loading
- **packages/harness-cli/** - Headless CLI for running and inspecting 8gent sessions
  - `harness run` / `harness inspect` / `harness doctor` / `harness sessions`
- **packages/specifications/** - Session spec v2 with full AI SDK data model
  - JSON schema, reader, writer for session persistence
- **apps/debugger/** - Next.js session debugger app
  - Session list, viewer, streaming, copy-as-JSON
- **benchmarks/** - Full v2 benchmark suite (39 benchmarks, 7 categories)
  - Autoresearch harness with Ollama + OpenRouter fallback
  - Experience-based model router (learns best model per domain)
  - Execution grader (SWE-bench style, 70% exec + 30% keyword)
  - 15 battle-test benchmarks across professional domains
  - Prompt mutation system with failure analysis
  - Overnight runner for continuous improvement
- **packages/dreams/** - Creative scripts for video generation
- **TUI overhaul**
  - Design-system-first architecture with primitives layer
  - Process sidebar (Ctrl+B) for background tasks
  - useLayout hook for centralized panel/pane state
  - Theme tokens and semantic color system
  - Pinned process sidebar with overflow scroll fix
- `8` CLI alias (short for `8gent`)
- Background task auto-promotion for long-running commands
- Spatial awareness and "orient first" rules in system prompt
- Loop detection and lightweight run log

### Changed
- **Breaking:** `packages/agent/` renamed to `packages/eight/`
- Agent now uses Vercel AI SDK ToolLoopAgent instead of raw fetch
- Session spec upgraded to v2 (incompatible with v1 sessions)
- System prompt refined with scaffolding guidance, dev server warnings
- All TUI components migrated from raw colors to design system primitives

### Fixed
- .env loading from repo root and ~/.8gent when running from another directory
- Tool call visibility in message stream
- Command failures now shown inline
- list_files no longer hides directories
- JSON tool format removed from prompt (uses native function calling)

### Battle Test Scores (v0.3.0)
| Benchmark | Domain | Score |
|-----------|--------|-------|
| BT001 | Auth System | 94 |
| BT002 | Event Architecture | 92 |
| BT003 | Data Pipeline | 100 |
| BT005 | State Machine | 92 |
| BT007 | SEO Audit | 96 |
| BT011 | Video Production | 100 |
| BT012 | Music Theory | 81 |
| BT014 | AI Consulting | 95 |

---

## [0.2.0] - 2026-03-10

### Added
- OpenRouter provider wired into TUI and agent runtime
- Benchmark suite v1 (bug-fixing, file-manipulation, feature-implementation)
- Autoresearch loop (Karpathy methodology)
- Few-shot examples per benchmark category
- Temperature sweep (0.3, 0.5, 0.7)
- Fullstack benchmarks (FS001-FS003, FS-MEGA-001)
- Agentic benchmarks (TC001, DP001, RE001, SD001, AR001, CB001, MR001)
- UI design benchmarks (UI001-UI008)
- Reporting module with token savings calculator

### Changed
- Prompt mutation system with deduplication (exact + 70% word overlap)

---

## [0.1.0] - 2026-02-28

### Added
- Initial release
- Ink v6 TUI with chat interface
- Ollama integration (local LLM inference)
- Basic tool system (file read/write, shell commands)
- System prompt with coding agent persona
- Demo savings calculator
