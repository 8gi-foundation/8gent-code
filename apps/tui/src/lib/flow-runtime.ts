/**
 * Flow-mode runtime: the one place the TUI touches flow modes (L3 part 2).
 *
 * flow-mode.ts is the pure rules and flow-capture.ts is the capture gate. This
 * file owns the live instances, in memory only, and gives the TUI four things:
 *
 *   canSpeak(kind)        the single gate before anything is spoken
 *   setFlowMode / cycle   user origin only (/mode, the cycle key)
 *   heardTranscript(...)  the push-to-talk path: capture gate, then the
 *                         controller, then the one-line outcome
 *   judgeProposal(...)    the judge may only lower or ask, 1.5 s, strict schema
 *
 * Nothing here writes disk or settings, and no transcript text is logged: the
 * controller's log holds signal classes only, and dropped speech is discarded.
 */

import type { PermissionMode } from "../../../../packages/permissions/permission-mode";
import {
	type RawCapture,
	type Utterance,
	buildJudgePrompt,
	createCaptureGate,
} from "./flow-capture";
import {
	DEFAULT_FLOW_MODE,
	FLOW_MODES,
	type FlowMode,
	type FlowModeController,
	JUDGE_TIMEOUT_MS,
	type Outcome,
	type SpeechKind,
	createFlowModeStore,
	flowModeLabel,
	isFlowMode,
	nextFlowMode,
	shouldSpeak,
} from "./flow-mode";

export type { FlowMode, Outcome, SpeechKind } from "./flow-mode";

export const MODE_USAGE = "Usage: /mode listen|think|quiet|act   (no argument shows the mode)";

/** What a transcript turned out to be. */
export type TranscriptResult =
	| { kind: "dropped" } // echo or not admitted: discarded, not logged
	| { kind: "prompt"; ack?: string } // ordinary speech: goes to the prompt as before
	| { kind: "consumed"; outcome: Outcome }; // a mode command or an answer to a proposal

export function createFlowRuntime(
	now: () => number = Date.now,
	userPerm: () => PermissionMode = () => "ask",
) {
	let permProvider = userPerm;
	const store = createFlowModeStore(now, () => permProvider());
	const gate = createCaptureGate(now);
	let tab = "default";
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const l of listeners) l();
	};
	const ctl = (): FlowModeController => store.forTab(tab);

	/** Run a controller action and tell the footer if the mode moved. */
	const after = (o: Outcome): Outcome => {
		if (o.changed) notify();
		return o;
	};

	return {
		/** The footer word for the active tab. Always one of the four, in every state. */
		footerWord: (): string => ctl().footer(),
		mode: (): FlowMode => ctl().mode,
		subscribe(cb: () => void): () => void {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		setActiveTab(id: string) {
			if (id === tab) return;
			tab = id;
			notify();
		},
		setUserPermission(fn: () => PermissionMode) {
			permProvider = fn;
		},
		setApprovalPending(on: boolean) {
			ctl().setApprovalPending(on);
		},

		/** The single gate before anything is spoken. Quiet speaks only the floors. */
		canSpeak(kind: SpeechKind = "final-reply"): boolean {
			return shouldSpeak(ctl().mode, kind);
		},

		/** /mode <name>. User origin: a person typed it. */
		setFlowMode(name: string): Outcome {
			const to = name.trim().toLowerCase();
			if (!isFlowMode(to)) return { changed: false, mode: ctl().mode, screen: MODE_USAGE };
			return after(ctl().userSwitch(to, "user-slash"));
		},
		/** The cycle key: act, think, quiet. User origin. */
		cycle(): Outcome {
			return after(ctl().userSwitch(nextFlowMode(ctl().mode), "user-key"));
		},
		/** Undo the last switch, whoever made it. Key or slash only. */
		restore(origin: "user-key" | "user-slash" = "user-slash"): Outcome {
			return after(ctl().restore(origin));
		},
		/** The on-screen keypress that confirms a spoken raise. */
		confirmOnScreen(): Outcome {
			return after(ctl().confirmOnScreen());
		},

		/** TTS bookkeeping for the echo gate. Returns the function to call when it ends. */
		speechStarted(text: string): () => void {
			gate.ttsStarted(text);
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				gate.ttsEnded();
			};
		},

		/**
		 * A transcript from push-to-talk. `pttActive` and the window come from the
		 * TUI input layer, never from the text. Dropped speech is discarded unlogged.
		 */
		/** Admit a capture as a user-voice utterance (judge path), or null. Same gate as heardTranscript. */
		admit: (raw: RawCapture): Utterance | null => gate.admit(raw),

		heardTranscript(raw: {
			text: string;
			pttActive: boolean;
			startedAt: number;
			endedAt: number;
		}): TranscriptResult {
			const u = gate.admit(raw);
			if (u === null) return { kind: "dropped" };
			const c = ctl();
			// A "yes" counts only for a pending proposal, and never for a tool approval.
			const ans = after(c.answer(u));
			if (ans.changed || ans.say) return { kind: "consumed", outcome: ans };
			const out = after(c.hear(u));
			if (out.changed || out.say || out.asking) return { kind: "consumed", outcome: out };
			// Ordinary speech. Listen acknowledges in one word; Quiet and the rest say nothing.
			return { kind: "prompt", ack: c.mode === "listen" ? "Noted." : undefined };
		},

		/**
		 * The judge's proposal path. `classify` gets the prompt (admitted user
		 * utterances only) and returns raw output. The judge can lower or ask:
		 * origin is fixed here, a late or unparseable answer changes nothing.
		 */
		async judgeProposal(
			u: Utterance,
			classify: (prompt: string) => Promise<unknown>,
		): Promise<Outcome> {
			const c = ctl();
			const ticket = c.beginJudge(u);
			if (ticket === null) return { changed: false, mode: c.mode };
			let raw: unknown = "timeout";
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				raw = await Promise.race([
					classify(buildJudgePrompt([u])),
					new Promise<unknown>((res) => {
						timer = setTimeout(() => res("timeout"), JUDGE_TIMEOUT_MS);
					}),
				]);
			} catch {
				raw = "timeout";
			} finally {
				if (timer) clearTimeout(timer);
			}
			return after(c.judgeResult(ticket, raw));
		},

		/** The controller's signal-class log for the active tab. No transcript text. */
		log: () => ctl().log,

		/** New session, resume, restart, daemon reattach: Act, nothing remembered. */
		resetSession() {
			store.resetSession();
			notify();
		},
	};
}

/** The process-wide instance: in memory, one per TUI process. */
export const flow = createFlowRuntime();

/** The single gate before anything is spoken. The spoken post-draft (#4373) calls this. */
export function canSpeak(kind: SpeechKind = "final-reply"): boolean {
	return flow.canSpeak(kind);
}

/** For the footer: the label for a mode word, and the full set for the usage line. */
export { DEFAULT_FLOW_MODE, FLOW_MODES, flowModeLabel };
