import { describe, it, expect, beforeEach } from "bun:test";
import * as path from "path";

const WORK_DIR = process.env.WORK_DIR || path.dirname(process.env.FIXTURE_PATH || ".");

let template: any, personalize: any, analytics: any;

beforeEach(async () => {
  try {
    template = await import(path.join(WORK_DIR, "template.ts"));
    personalize = await import(path.join(WORK_DIR, "personalize.ts"));
    analytics = await import(path.join(WORK_DIR, "analytics.ts"));
  } catch {}
});

describe("Email Template", () => {
  it("render replaces {{name}} with value", () => {
    const Template = template.Template || template.default;
    const t = new Template("Hello {{name}}!", "Greeting");
    const result = t.render({ name: "Alice" });
    expect(result).toContain("Alice");
    expect(result).not.toContain("{{name}}");
  });

  it("render handles missing vars gracefully", () => {
    const Template = template.Template || template.default;
    const t = new Template("Hello {{name}}, welcome to {{company}}!", "Welcome");
    const result = t.render({ name: "Bob" });
    expect(result).toContain("Bob");
    expect(typeof result).toBe("string");
  });

  it("validate checks required vars", () => {
    const Template = template.Template || template.default;
    const t = new Template("Hello {{name}}, your order {{orderId}} is ready", "Order");
    const errors = t.validate({ name: "Alice" });
    expect(errors.length).toBeGreaterThan(0);
  });

  it("addSection appends section to template", () => {
    const Template = template.Template || template.default;
    const t = new Template("Hello!", "Greeting");
    t.addSection("footer", "Thanks for reading!");
    const result = t.render({});
    expect(result).toContain("Thanks for reading!");
  });

  it("toHTML wraps content in HTML", () => {
    const Template = template.Template || template.default;
    const t = new Template("Hello {{name}}!", "Greeting");
    const html = t.toHTML({ name: "Alice" });
    expect(html).toContain("<html");
    expect(html).toContain("Alice");
  });

  it("subject is accessible", () => {
    const Template = template.Template || template.default;
    const t = new Template("Body content", "My Subject Line");
    expect(t.subject).toBe("My Subject Line");
  });
});

describe("Email Personalize", () => {
  it("personalize replaces recipient fields", () => {
    const personalizeFn = personalize.personalize || personalize.default?.personalize;
    const result = personalizeFn("Hello {{firstName}} {{lastName}}", {
      firstName: "Jane",
      lastName: "Doe",
    });
    expect(result).toContain("Jane");
    expect(result).toContain("Doe");
  });

  it("personalize uses fallbacks for optional fields", () => {
    const personalizeFn = personalize.personalize || personalize.default?.personalize;
    const result = personalizeFn("Hello {{firstName}}, your title is {{title}}", {
      firstName: "Jane",
    }, { title: "Valued Customer" });
    expect(result).toContain("Jane");
    expect(result).toContain("Valued Customer");
  });

  it("generateSubjectVariants returns correct count", () => {
    const genVariants = personalize.generateSubjectVariants || personalize.default?.generateSubjectVariants;
    const result = genVariants("Check out our sale!", 3);
    expect(result.length).toBe(3);
  });

  it("segmentRecipients groups correctly", () => {
    const segment = personalize.segmentRecipients || personalize.default?.segmentRecipients;
    const recipients = [
      { email: "a@test.com", tier: "premium" },
      { email: "b@test.com", tier: "free" },
      { email: "c@test.com", tier: "premium" },
    ];
    const result = segment(recipients, "tier");
    expect(result.premium.length).toBe(2);
    expect(result.free.length).toBe(1);
  });
});

describe("Email Analytics", () => {
  it("CampaignTracker.track records events", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("opened", "user1");
    tracker.track("sent", "user2");
    const events = tracker.getEvents();
    expect(events.length).toBe(3);
  });

  it("getMetrics returns correct rates", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("sent", "user2");
    tracker.track("opened", "user1");
    const metrics = tracker.getMetrics();
    expect(metrics).toHaveProperty("openRate");
    expect(metrics).toHaveProperty("clickRate");
  });

  it("openRate equals opened/sent", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("sent", "user2");
    tracker.track("opened", "user1");
    const metrics = tracker.getMetrics();
    expect(metrics.openRate).toBe(0.5);
  });

  it("clickRate equals clicked/opened", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("sent", "user2");
    tracker.track("opened", "user1");
    tracker.track("opened", "user2");
    tracker.track("clicked", "user1");
    const metrics = tracker.getMetrics();
    expect(metrics.clickRate).toBe(0.5);
  });

  it("getTopPerformers returns sorted list", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("sent", "user2");
    tracker.track("sent", "user3");
    tracker.track("opened", "user1");
    tracker.track("opened", "user2");
    tracker.track("clicked", "user1");
    const top = tracker.getTopPerformers();
    expect(top[0]).toBe("user1");
  });

  it("generateReport returns structured data", () => {
    const Tracker = analytics.CampaignTracker || analytics.default;
    const tracker = new Tracker("campaign-1");
    tracker.track("sent", "user1");
    tracker.track("opened", "user1");
    const report = tracker.generateReport();
    expect(report).toHaveProperty("campaignId");
    expect(report).toHaveProperty("metrics");
  });
});
