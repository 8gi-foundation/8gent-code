/**
 * paraphrase-set.ts - the corpus behind the embedder comparison.
 *
 * These are test fixtures, not product data: they exist only inside the
 * benchmark and are never written to a real memory store. Each pair is one
 * memory plus one query that asks for it in different words. Queries are
 * written to share no content word with their memory, so lexical match (FTS5)
 * cannot win and only a semantic embedder can retrieve the right row. The
 * 60 memories are each other's distractors: every query is scored against the
 * whole corpus, chance recall@5 is 5/60.
 *
 * Fixed ids so labels can name them. Order is stable on purpose.
 */

export interface ParaphrasePair {
  id: string;
  key: string;
  value: string;
  query: string;
}

export const PARAPHRASE_PAIRS: ParaphrasePair[] = [
  { id: "pp01", key: "db-port", value: "The primary database accepts connections on TCP port 5432", query: "which socket number do clients dial to reach our main data store" },
  { id: "pp02", key: "cache-expiry", value: "Cached entries expire after five minutes", query: "how soon do stored lookups go stale" },
  { id: "pp03", key: "branch-rule", value: "Never commit straight to the trunk branch; use a feature branch and review", query: "am I allowed to ship changes without a second pair of eyes" },
  { id: "pp04", key: "nightly-job", value: "The reconciliation batch runs at two in the morning UTC", query: "at what hour does the after-dark accounting sweep start" },
  { id: "pp05", key: "token-rotation", value: "Rotate the API credentials every ninety days", query: "how often should we swap out our access keys" },
  { id: "pp06", key: "log-hygiene", value: "Redact passwords and tokens before writing application logs", query: "what must be scrubbed before diagnostics are saved to disk" },
  { id: "pp07", key: "retry-policy", value: "Failed webhook deliveries are retried with exponential backoff up to six times", query: "what happens when a callback to a customer endpoint does not go through" },
  { id: "pp08", key: "oncall", value: "The pager rotation changes hands every Monday at nine", query: "when does the person responsible for night alerts get swapped" },
  { id: "pp09", key: "backup-window", value: "Database snapshots are taken hourly and kept for thirty days", query: "how far back can we restore our records from a copy" },
  { id: "pp10", key: "rate-limit", value: "Each client may send at most one hundred requests per minute", query: "what is the throttle ceiling for a single caller" },
  { id: "pp11", key: "ci-timeout", value: "Pipeline jobs are killed if they run longer than twenty minutes", query: "how long can an automated build take before it is cut off" },
  { id: "pp12", key: "style-indent", value: "Source files use tabs for indentation, not spaces", query: "whitespace convention for the start of each line of code" },
  { id: "pp13", key: "release-cadence", value: "We cut a new version every second Thursday", query: "how frequently do customers receive an updated build" },
  { id: "pp14", key: "incident-owner", value: "The incident commander writes the postmortem within two days", query: "who documents what went wrong after an outage and by when" },
  { id: "pp15", key: "queue-limit", value: "Background jobs wait in a queue capped at ten thousand items", query: "maximum backlog of deferred work before new items are refused" },
  { id: "pp16", key: "tls-version", value: "Only TLS 1.3 connections are accepted by the edge proxy", query: "oldest encryption protocol our front door will negotiate" },
  { id: "pp17", key: "image-size", value: "Uploaded avatars are resized to 256 pixels square", query: "dimensions profile pictures end up with after submission" },
  { id: "pp18", key: "session-length", value: "User sessions expire after thirty minutes of inactivity", query: "how long can someone sit idle before being signed out" },
  { id: "pp19", key: "feature-flags", value: "New features ship dark behind a flag and are enabled per cohort", query: "how do we expose unfinished functionality to a small slice of people" },
  { id: "pp20", key: "dependency-policy", value: "Every new package needs a security review before it is added", query: "what vetting is required prior to pulling in third-party libraries" },
  { id: "pp21", key: "office-coffee", value: "The espresso machine is on the third floor kitchen", query: "where can I get a caffeinated drink in the building" },
  { id: "pp22", key: "holiday", value: "The company is closed between Christmas and New Year", query: "when is the whole team off during winter" },
  { id: "pp23", key: "expense-limit", value: "Purchases above two hundred euros need manager approval", query: "spending threshold that triggers a sign-off from my boss" },
  { id: "pp24", key: "vpn", value: "Remote staff must connect through the corporate tunnel to reach internal tools", query: "how do people working from home get to private company sites" },
  { id: "pp25", key: "standup", value: "The daily sync meeting starts at ten past nine", query: "what time does the morning team huddle begin" },
  { id: "pp26", key: "api-versioning", value: "Breaking changes ship under a new path prefix such as v2", query: "how do we avoid disrupting integrators when the contract changes" },
  { id: "pp27", key: "pagination", value: "List endpoints return fifty items per page by default", query: "default batch size when fetching collections from the service" },
  { id: "pp28", key: "currency", value: "All prices are stored as integer cents to avoid rounding errors", query: "why are monetary amounts kept as whole numbers" },
  { id: "pp29", key: "timezone", value: "Timestamps are stored in UTC and converted in the browser", query: "where does conversion to the viewer's local clock happen" },
  { id: "pp30", key: "password-rules", value: "Passwords need at least twelve characters", query: "minimum length of a secret phrase for logging in" },
  { id: "pp31", key: "cdn", value: "Static assets are served from the edge network with a one year cache header", query: "how long can browsers hold on to images and scripts" },
  { id: "pp32", key: "search-engine", value: "Full text search is powered by a local SQLite index", query: "what technology finds documents by their words" },
  { id: "pp33", key: "load-test", value: "Load tests target two thousand concurrent users", query: "how much simultaneous traffic must the system survive in rehearsals" },
  { id: "pp34", key: "error-budget", value: "Availability target is 99.9 percent per month", query: "how much downtime are we promising customers can occur" },
  { id: "pp35", key: "gdpr-delete", value: "Account deletion requests are completed within thirty days", query: "deadline for erasing a person's data after they ask" },
  { id: "pp36", key: "email-sender", value: "Transactional email goes out from the notifications subdomain", query: "which address do automated receipts come from" },
  { id: "pp37", key: "staging", value: "Staging is wiped and reseeded every Sunday night", query: "when does the rehearsal environment get reset" },
  { id: "pp38", key: "monorepo", value: "All packages live in one repository managed with workspaces", query: "do we keep each component in its own source tree or together" },
  { id: "pp39", key: "lint", value: "A pre-push hook runs the linter and refuses the push on errors", query: "what stops sloppy formatting from leaving my laptop" },
  { id: "pp40", key: "secrets-store", value: "Secrets are read from the sealed vault, never from environment files in git", query: "where do confidential values live instead of the repository" },
  { id: "pp41", key: "onboarding", value: "New hires get laptop access on their first morning", query: "when does a freshly joined employee receive their computer" },
  { id: "pp42", key: "mobile-min", value: "The app supports iOS 16 and later", query: "oldest phone operating system we still cater to" },
  { id: "pp43", key: "font", value: "Headings use the Inter typeface at semibold weight", query: "which lettering style appears on our titles" },
  { id: "pp44", key: "color-ban", value: "Purple and pink hues are banned from the brand palette", query: "which shades must never appear in our visual identity" },
  { id: "pp45", key: "support-hours", value: "Customer support answers tickets from eight to six on weekdays", query: "when can a user expect a human to reply to a complaint" },
  { id: "pp46", key: "refund", value: "Refunds are issued within fourteen days of purchase", query: "how long after buying can someone get their money back" },
  { id: "pp47", key: "shard-key", value: "Event tables are partitioned by tenant identifier", query: "how is data split across storage nodes for each customer" },
  { id: "pp48", key: "crash-reports", value: "Crash dumps are stored locally and uploaded only with explicit consent", query: "are failure traces sent anywhere without asking the user" },
  { id: "pp49", key: "model-default", value: "The default local model is a fourteen billion parameter quantized build", query: "which neural network runs on the device out of the box" },
  { id: "pp50", key: "embedding-dim", value: "Vectors are stored with 768 dimensions in the sqlite index", query: "width of the numeric fingerprints kept for similarity lookup" },
  { id: "pp51", key: "docker-base", value: "Containers are built from the slim Debian base image", query: "which minimal operating system layer do our packaged services start from" },
  { id: "pp52", key: "disk-floor", value: "Builds are refused when free disk space drops under ten gigabytes", query: "storage headroom required before compilation is allowed to start" },
  { id: "pp53", key: "review-count", value: "Pull requests need two approvals before merge", query: "how many colleagues must sign off on a change" },
  { id: "pp54", key: "hotfix", value: "Hotfixes branch from the latest release tag, not from trunk", query: "where does an urgent patch start from" },
  { id: "pp55", key: "log-retention", value: "Audit logs are kept for ninety days then deleted", query: "how long do we hold records of who did what" },
  { id: "pp56", key: "ws-heartbeat", value: "WebSocket clients send a ping every thirty seconds", query: "how often does a live connection prove it is still alive" },
  { id: "pp57", key: "cron-tz", value: "Scheduled tasks run on the server's UTC clock", query: "which timezone do recurring automations follow" },
  { id: "pp58", key: "upload-cap", value: "File uploads are capped at fifty megabytes", query: "biggest attachment a person can submit" },
  { id: "pp59", key: "naming", value: "Branches are named feat slash description or fix slash description", query: "what pattern should the label of a work stream follow" },
  { id: "pp60", key: "a11y", value: "Every interactive control must be reachable by keyboard alone", query: "must people without a mouse be able to operate all buttons" },
];
