// Seed a #boardroom channel with the 8 officers as members + a welcome message
// into the DAEMON's Table db so the Flow Table pane shows real content on open.
// Idempotent: find-or-create, ensure members, ensure welcome.
import { TableStore } from "../packages/table/store";
import { OFFICERS } from "../packages/table/officers";
import { ensureIdentity } from "../packages/table/identity";

const store = new TableStore(); // default path = daemon's db
// The Flow/EightBody app connects over loopback and the daemon PINS it to
// "human:local" (no-auth loopback identity). Membership MUST use that same id or
// the local human cannot post in their own channel. Keep human:james too so any
// signed-james history stays valid, but human:local is the one the app acts as.
const human = "human:local";
ensureIdentity(human);
ensureIdentity("human:james");

let chan: any = store.listChannels().find((c: any) => c.name === "boardroom");
if (!chan) {
  chan = store.createChannel({
    name: "boardroom",
    type: "stream",
    visibility: "open",
    topic: "The eight, at the table. Human + agents, local models, signed.",
    createdBy: human,
  });
}

// The human members. The channel CREATOR is not auto-added as a member row, so
// without this the local human (human:local, pinned by the loopback daemon) is
// refused with TABLE_AUTH when they try to post in their own channel.
// Only an owner/admin may add members, so the authority is the channel's own
// creator (auto-seeded as owner by createChannel), never a not-yet-member id.
const authority = chan.createdBy;
const addMemberSafe = (pid: string, role: string) => {
  try {
    store.addMember({ channelId: chan.id, participantId: pid, role, addedBy: authority });
  } catch (e: any) {
    if (!String(e?.message || "").toLowerCase().includes("member")) console.error(pid, e?.message);
  }
};
addMemberSafe("human:local", "owner");
addMemberSafe("human:james", "owner");

for (const code of Object.keys(OFFICERS)) {
  const pid = `agent:${code}`;
  ensureIdentity(pid);
  addMemberSafe(pid, "member");
}

if (store.listMessages(chan.id).length === 0) {
  store.postMessage({
    channelId: chan.id,
    authorId: human,
    content: "Welcome to the Table. The eight officers are seated, each on a local model. @mention one to talk. Everything here is signed into the ledger.",
  });
}

console.log(JSON.stringify({
  channel: chan.name,
  id: chan.id,
  members: store.listMembers(chan.id).map((m: any) => m.participantId),
  messages: store.listMessages(chan.id).length,
  ledger: store.getLedger().verify(),
}, null, 2));
