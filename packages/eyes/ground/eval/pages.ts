/**
 * Local test pages for the grounding eval. Plain HTML, no network, loaded into
 * 8gent Browser as data: URLs. Each target names an element by CSS selector;
 * the browser measures its box, so labels come from layout, not from hand.
 * Instructions are written the way a planner would phrase them.
 */

export interface PageSpec {
	id: string;
	html: string;
	targets: { instruction: string; selector: string }[];
}

const base = (title: string, body: string, dark = false) => `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>
:root{--bg:${dark ? "#14161c" : "#f6f5f2"};--card:${dark ? "#1d2029" : "#fff"};--fg:${dark ? "#e4e5e9" : "#1d1f24"};--mut:${dark ? "#9aa0ab" : "#6b6f78"};--line:${dark ? "#2c303b" : "#dedcd6"};--acc:#e8610a}
*{box-sizing:border-box}body{margin:0;font:15px/1.4 -apple-system,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:18px;padding:14px 28px;border-bottom:1px solid var(--line);background:var(--card)}
header .brand{font-weight:700;font-size:18px}header nav{display:flex;gap:16px;flex:1}header a{color:var(--mut);text-decoration:none}
main{padding:24px 28px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px}
label{display:block;font-size:13px;color:var(--mut);margin:12px 0 4px}input[type=text],input[type=email],input[type=password],select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);font:inherit}
button{font:inherit;padding:9px 16px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--acc);border-color:var(--acc);color:#fff}button.danger{color:#c0392b;border-color:#e3b2ac}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--mut);text-transform:uppercase}
.row{display:flex;gap:16px}.row>*{flex:1}.toggle{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}
.sw{width:42px;height:24px;border-radius:12px;background:var(--line);position:relative;border:0;padding:0}.sw.on{background:var(--acc)}.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:9px;background:#fff}.sw.on::after{left:21px}
.icon{width:36px;height:36px;padding:0;display:inline-grid;place-items:center;font-size:17px}
</style><body>${body}`;

const nav = (active: string) =>
	`<header><span class="brand">8gent</span><nav>${["Home", "Tasks", "Memory", "Settings"].map((n) => `<a href="#" ${n === active ? 'style="color:var(--fg);font-weight:600"' : ""}>${n}</a>`).join("")}</nav><input type="text" id="search" placeholder="Search" style="width:220px"><button id="profile" class="icon" aria-label="Profile">&#9786;</button></header>`;

export const PAGES: PageSpec[] = [
	{
		id: "contact-form",
		html: base(
			"Contact",
			`${nav("Home")}<main><div class="card" style="max-width:620px"><h2 style="margin-top:0">Contact us</h2>
<div class="row"><div><label for="fn">First name</label><input type="text" id="fn"></div><div><label for="ln">Last name</label><input type="text" id="ln"></div></div>
<label for="em">Email</label><input type="email" id="em"><label for="topic">Topic</label><select id="topic"><option>General</option><option>Billing</option></select>
<label style="display:flex;gap:8px;align-items:center;color:var(--fg)"><input type="checkbox" id="copy"> Send me a copy</label>
<div style="margin-top:16px;display:flex;gap:10px"><button class="primary" id="send">Send message</button><button id="clear">Clear</button></div></div></main>`,
		),
		targets: [
			{ instruction: "the Last name field", selector: "#ln" },
			{ instruction: "the Send message button", selector: "#send" },
			{ instruction: "the Send me a copy checkbox", selector: "#copy" },
		],
	},
	{
		id: "settings-toggles",
		html: base(
			"Settings",
			`${nav("Settings")}<main><div class="card" style="max-width:560px"><h2 style="margin-top:0">Notifications</h2>
<div class="toggle"><span>Weekly digest email</span><button class="sw" id="digest" aria-label="Weekly digest"></button></div>
<div class="toggle"><span>Task finished alerts</span><button class="sw on" id="alerts" aria-label="Task alerts"></button></div>
<div class="toggle"><span>Voice notes</span><button class="sw" id="voice" aria-label="Voice notes"></button></div>
<div style="margin-top:18px"><button class="primary" id="save">Save changes</button> <button class="danger" id="signout">Sign out</button></div></div></main>`,
		),
		targets: [
			{ instruction: "the weekly digest email toggle", selector: "#digest" },
			{ instruction: "the Save changes button", selector: "#save" },
			{ instruction: "the Settings link in the top navigation", selector: "header nav a:nth-child(4)" },
		],
	},
	{
		id: "settings-toggles-dark",
		html: "",
		targets: [
			{ instruction: "the voice notes toggle", selector: "#voice" },
			{ instruction: "the Sign out button", selector: "#signout" },
		],
	},
	{
		id: "file-table",
		html: base(
			"Files",
			`${nav("Memory")}<main><div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0">Files</h2><button class="primary" id="upload">Upload</button></div>
<table style="margin-top:12px"><tr><th>Name</th><th>Size</th><th>Modified</th><th></th></tr>
${[
	["invoice-september.pdf", "212 KB", "Oct 2"],
	["notes-standup.md", "4 KB", "Oct 9"],
	["budget-2027.xlsx", "88 KB", "Oct 10"],
	["photo-team.jpg", "2.1 MB", "Oct 11"],
]
	.map(
		([n, s, d], i) =>
			`<tr><td>${n}</td><td>${s}</td><td>${d}</td><td style="text-align:right"><button id="dl${i}">Download</button> <button class="danger" id="del${i}">Delete</button></td></tr>`,
	)
	.join("")}</table></div></main>`,
		),
		targets: [
			{ instruction: "the Download button for budget-2027.xlsx", selector: "#dl2" },
			{ instruction: "the Delete button on the notes-standup.md row", selector: "#del1" },
			{ instruction: "the Upload button", selector: "#upload" },
		],
	},
	{
		id: "modal-dialog",
		html: base(
			"Confirm",
			`${nav("Tasks")}<main><div class="card" style="opacity:.4"><h2>Tasks</h2><p>12 open tasks</p></div></main>
<div style="position:fixed;inset:0;background:rgba(0,0,0,.35);display:grid;place-items:center"><div class="card" style="width:420px"><h3 style="margin-top:0">Archive 3 tasks?</h3><p style="color:var(--mut)">They move to the archive and can be restored later.</p>
<div style="display:flex;justify-content:flex-end;gap:10px"><button id="cancel">Cancel</button><button class="primary" id="archive">Archive</button></div><button class="icon" id="x" aria-label="Close" style="position:absolute;margin:-150px 0 0 360px;border:0">&#10005;</button></div></div>`,
		),
		targets: [
			{ instruction: "the Archive button in the dialog", selector: "#archive" },
			{ instruction: "the Cancel button", selector: "#cancel" },
		],
	},
	{
		id: "toolbar-icons",
		html: base(
			"Editor",
			`${nav("Tasks")}<main><div class="card"><div style="display:flex;gap:6px;border-bottom:1px solid var(--line);padding-bottom:10px">
<button class="icon" id="bold" aria-label="Bold"><b>B</b></button><button class="icon" id="italic" aria-label="Italic"><i>I</i></button><button class="icon" id="underline" aria-label="Underline"><u>U</u></button>
<span style="width:12px"></span><button class="icon" id="link" aria-label="Insert link">&#128279;</button><button class="icon" id="image" aria-label="Insert image">&#128444;</button><button class="icon" id="trash" aria-label="Delete">&#128465;</button>
<span style="flex:1"></span><button id="publish" class="primary">Publish</button></div><textarea rows="9" style="margin-top:12px;border:0">Draft: weekly update for the team.</textarea></div></main>`,
		),
		targets: [
			{ instruction: "the italic button in the toolbar", selector: "#italic" },
			{ instruction: "the trash can icon", selector: "#trash" },
			{ instruction: "the Publish button", selector: "#publish" },
		],
	},
	{
		id: "inbox",
		html: base(
			"Inbox",
			`${nav("Home")}<main style="display:flex;gap:20px"><div style="width:180px"><button class="primary" id="compose" style="width:100%">Compose</button>
<div style="margin-top:14px;display:grid;gap:8px"><a href="#" id="f-inbox">Inbox (4)</a><a href="#" id="f-sent">Sent</a><a href="#" id="f-drafts">Drafts</a><a href="#" id="f-spam">Spam</a></div></div>
<div class="card" style="flex:1;padding:0">${[
				["Aoife", "Rehearsal moved to Thursday"],
				["Bank", "Your statement is ready"],
				["Marcus", "Photos from Saturday"],
				["Calendar", "Reminder: dentist 10:30"],
			]
				.map(
					([f, s], i) =>
						`<div id="m${i}" style="display:flex;gap:16px;padding:12px 16px;border-bottom:1px solid var(--line)"><b style="width:110px">${f}</b><span>${s}</span></div>`,
				)
				.join("")}</div></main>`,
		),
		targets: [
			{ instruction: "the email from Marcus about photos", selector: "#m2" },
			{ instruction: "the Compose button", selector: "#compose" },
			{ instruction: "the Drafts folder", selector: "#f-drafts" },
		],
	},
	{
		id: "checkout",
		html: base(
			"Checkout",
			`${nav("Home")}<main class="row"><div class="card"><h3 style="margin-top:0">Delivery</h3><label for="addr">Address</label><input type="text" id="addr"><div class="row"><div><label for="city">City</label><input type="text" id="city"></div><div><label for="zip">Eircode</label><input type="text" id="zip"></div></div>
<label for="when">Delivery slot</label><select id="when"><option>Tomorrow 9-12</option></select></div>
<div class="card" style="max-width:320px"><h3 style="margin-top:0">Order</h3><p>2 items</p><p style="font-size:22px;font-weight:700">EUR 34.50</p><label style="display:flex;gap:8px;align-items:center;color:var(--fg)"><input type="checkbox" id="terms"> I agree to the terms</label><button class="primary" id="pay" style="width:100%;margin-top:12px">Place order</button></div></main>`,
		),
		targets: [
			{ instruction: "the Eircode field", selector: "#zip" },
			{ instruction: "the Place order button", selector: "#pay" },
			{ instruction: "the agree to the terms checkbox", selector: "#terms" },
		],
	},
	{
		id: "calendar",
		html: base(
			"Calendar",
			`${nav("Tasks")}<main><div class="card"><div style="display:flex;align-items:center;gap:10px"><button class="icon" id="prev" aria-label="Previous month">&#8249;</button><b>October 2026</b><button class="icon" id="next" aria-label="Next month">&#8250;</button><span style="flex:1"></span><button id="today">Today</button></div>
<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:12px">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div style="color:var(--mut);font-size:12px">${d}</div>`).join("")}
${Array.from({ length: 31 }, (_, i) => `<div id="d${i + 1}" style="border:1px solid var(--line);border-radius:6px;height:38px;padding:4px;font-size:13px">${i + 1}${i + 1 === 15 ? ' <span style="background:var(--acc);color:#fff;border-radius:4px;padding:0 4px;font-size:11px">Gig</span>' : ""}</div>`).join("")}</div></div></main>`,
		),
		targets: [
			{ instruction: "the next month arrow", selector: "#next" },
			{ instruction: "the day with the Gig event", selector: "#d15" },
			{ instruction: "the Today button", selector: "#today" },
		],
	},
	{
		id: "search-results",
		html: base(
			"Search",
			`${nav("Memory")}<main><div class="card"><div style="display:flex;gap:10px"><input type="text" id="q" value="sovereign grounding"><button class="primary" id="go">Search</button></div>
${["Grounding notes from the 8TO plan", "Local vision models on a 32 GB Mac", "Why the browser test was 0 of 3"]
	.map(
		(t, i) =>
			`<div style="padding:14px 0;border-bottom:1px solid var(--line)"><a href="#" id="r${i}" style="font-size:17px;color:var(--acc)">${t}</a><div style="color:var(--mut);font-size:13px">memory - ${i + 2} days ago</div></div>`,
	)
	.join("")}<div style="margin-top:12px;display:flex;gap:8px"><button id="p1">1</button><button id="p2">2</button><button id="pnext">Next page</button></div></div></main>`,
		),
		targets: [
			{ instruction: "the result about local vision models", selector: "#r1" },
			{ instruction: "the Next page button", selector: "#pnext" },
			{ instruction: "the search box", selector: "#q" },
		],
	},
];

// Dark variant of the settings page, same layout, different palette.
PAGES[2].html = base(
	"Settings",
	PAGES[1].html.slice(PAGES[1].html.indexOf("<body>") + 6),
	true,
);
