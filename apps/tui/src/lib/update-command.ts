/**
 * /update in the TUI. Saves the session, runs the same update as
 * `8gent update`, and on success asks the launcher to start a fresh 8gent
 * that resumes the same session (see packages/eight/update-resume.ts). On
 * failure the session stays open and the error is shown.
 */
export interface TuiUpdateDeps {
	/** Save the current conversation now; returns the session id, or null when there is none. */
	saveSession: () => string | null;
	/** Run the update (runUpdateCommand); calls `report` with the outcome, resolves to the exit code. */
	runUpdate: (
		log: (line: string) => void,
		report: (o: { updated: boolean; to?: string }) => void,
	) => Promise<number>;
	say: (line: string) => void;
	/** Record the resume request and close the TUI so the launcher can start the new 8gent. */
	relaunch: (req: { sessionId?: string; note: string }) => void;
}

export type TuiUpdateOutcome = "relaunched" | "unchanged" | "failed";

export async function runTuiUpdate(d: TuiUpdateDeps): Promise<TuiUpdateOutcome> {
	let sessionId: string | null = null;
	try {
		sessionId = d.saveSession();
	} catch (err) {
		d.say(
			`Could not save the session first (${err instanceof Error ? err.message : String(err)}); not updating.`,
		);
		return "failed";
	}
	let outcome: { updated: boolean; to?: string } = { updated: false };
	let code: number;
	try {
		d.say("Updating 8gent...");
		code = await d.runUpdate(
			(line) => d.say(line),
			(o) => (outcome = o),
		);
	} catch (err) {
		d.say(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
		return "failed";
	}
	if (code !== 0) {
		d.say("The update did not complete. Your session is still open.");
		return "failed";
	}
	if (!outcome.updated) return "unchanged";
	d.relaunch({
		sessionId: sessionId ?? undefined,
		note: `Updated to ${outcome.to ?? "the newest version"}${sessionId ? ", resumed your session" : ""}.`,
	});
	return "relaunched";
}

/** How the launcher described this install (bin/8gent.ts spawnTui); falls back to this module. */
export function launcherContext(
	env: Record<string, string | undefined> = process.env,
	here = import.meta.url,
) {
	return {
		currentVersion: env.EIGHT_RUNNING_VERSION || "0.0.0",
		modulePath: env.EIGHT_LAUNCHER_MODULE || here,
		embedded: env.EIGHT_LAUNCHER_EMBEDDED === "1",
	};
}

/**
 * The TUI cannot read a y/N (Ink owns stdin), so confirmation is two typed
 * steps: the first /update shows the origin and incoming commits and stops;
 * a second /update for the SAME question applies it. A different question
 * (new commits, another origin) starts over.
 */
export function makeTwoStepConfirm(say: (line: string) => void) {
	let pending: string | null = null;
	return async (question: string): Promise<boolean> => {
		if (pending === question) {
			pending = null;
			return true;
		}
		pending = question;
		say(`${question}\nNothing was changed. Type /update again to apply.`);
		return false;
	};
}
