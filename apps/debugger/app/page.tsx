import type { Metadata } from "next";
import { GET as getSessions } from "./api/sessions/route";
import HomeClient from "./HomeClient";
import type { SessionInfo } from "./api/sessions/route";

export const metadata: Metadata = {
	title: "8gent Debugger — Sessions",
	description: "Live session inspector for 8gent-code",
};

export const dynamic = "force-dynamic";

export default async function Home() {
	// Server-side initial load. Polling for updates happens client-side.
	let initialSessions: SessionInfo[] = [];
	try {
		const res = await getSessions();
		const data = await res.json();
		if (Array.isArray(data)) initialSessions = data as SessionInfo[];
	} catch {
		// fall through with empty list; client will retry
	}

	return <HomeClient initialSessions={initialSessions} />;
}
