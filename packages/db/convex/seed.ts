import { mutation } from "./_generated/server"

const INITIAL_SUBMISSIONS = [
  {
    slug: "uk-lords-nhs-ai-2026",
    title: "UK House of Lords - NHS Personalised Medicine and AI",
    subtitle:
      "Written evidence to the Science and Technology Committee inquiry on Innovation in the NHS: Personalised Medicine and AI",
    href: null,
    jurisdiction: "United Kingdom",
    committee: "House of Lords Science and Technology Committee",
    committee_chair: "Lord Mair",
    inquiry_url: "https://committees.parliament.uk/call-for-evidence/3865",
    deadline: "23:59 BST, 20 April 2026",
    deadline_iso: "2026-04-20T22:59:00Z",
    submitted_at: "2026-04-21",
    submitted_via:
      "Email to hlscience@parliament.uk (portal deadline missed; clerk requested to consider)",
    status: "Submitted" as const,
    source_file: "submissions/uk-lords-nhs-ai-2026/james-spalding-submission-draft.md",
    pdf: "submissions/uk-lords-nhs-ai-2026/james-spalding-submission-v2.pdf",
    docx: "submissions/uk-lords-nhs-ai-2026/james-spalding-submission-v2.docx",
    sort_order: 10,
  },
  {
    slug: "ai-bill-2026",
    title: "Oireachtas AI Bill 2026",
    subtitle:
      "Pre-legislative scrutiny of the General Scheme of the Regulation of Artificial Intelligence Bill 2026",
    href: "/submissions/ai-bill-2026",
    jurisdiction: "Ireland",
    committee: "Joint Committee on Enterprise, Tourism and Employment",
    committee_chair: null,
    inquiry_url: null,
    deadline: "13 April 2026, 5:30pm",
    deadline_iso: "2026-04-13T16:30:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "Submitted" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 20,
  },
  {
    slug: "sa-ai-policy-2026",
    title: "South Africa National AI Policy Framework",
    subtitle:
      "Joint submission with Lisle Jenneke on the K-shaped economy, UBAI, and digital sovereignty",
    href: null,
    jurisdiction: "South Africa",
    committee: "Department of Communications and Digital Technologies",
    committee_chair: null,
    inquiry_url: null,
    deadline: "10 June 2026",
    deadline_iso: "2026-06-10T23:59:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "In progress" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 30,
  },
  {
    slug: "un-global-dialogue-ai-governance-2026",
    title: "UN Global Dialogue on AI Governance",
    subtitle:
      "Written submissions for the UN multi-stakeholder consultations on international AI governance ahead of the Geneva session 8-9 July 2026",
    href: null,
    jurisdiction: "United Nations",
    committee: "UN Office for Digital and Emerging Technologies",
    committee_chair: null,
    inquiry_url:
      "https://www.un.org/global-dialogue-ai-governance/en/consultations",
    deadline: "11:59pm EDT, 30 April 2026",
    deadline_iso: "2026-05-01T03:59:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 40,
  },
  {
    slug: "ofcom-uk-platform-reports-2026",
    title: "Ofcom UK - Platform reporting on AI features and child safety",
    subtitle:
      "Joint ICO-Ofcom statement on age assurance, anti-grooming, safer feeds, and AI feature risk assessments",
    href: null,
    jurisdiction: "United Kingdom",
    committee: "Ofcom",
    committee_chair: null,
    inquiry_url: "https://www.ofcom.org.uk/online-safety/",
    deadline: "30 April 2026",
    deadline_iso: "2026-04-30T23:59:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 50,
  },
  {
    slug: "ec-avmsd-review-2026",
    title: "EU Audiovisual Media Services Directive review",
    subtitle:
      "DG CNECT consultation on AVMSD evaluation covering deepfakes, AI-generated content, and media provenance",
    href: null,
    jurisdiction: "European Union",
    committee: "European Commission (DG CNECT)",
    committee_chair: null,
    inquiry_url:
      "https://digital-strategy.ec.europa.eu/en/consultations/commission-seeks-feedback-evaluation-and-review-audiovisual-media-services-directive",
    deadline: "1 May 2026",
    deadline_iso: "2026-05-01T23:59:00+02:00",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 60,
  },
  {
    slug: "sdaia-responsible-ai-policy-2026",
    title: "Saudi Arabia SDAIA - Draft Responsible AI Policy",
    subtitle:
      "Public consultation on watermarking, provenance, bias mitigation, and privacy-by-design",
    href: null,
    jurisdiction: "Saudi Arabia",
    committee: "Saudi Data and AI Authority (SDAIA)",
    committee_chair: null,
    inquiry_url: "https://istitlaa.ncc.gov.sa/",
    deadline: "3 May 2026",
    deadline_iso: "2026-05-03T20:59:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 70,
  },
  {
    slug: "ec-ai-energy-emissions-2026",
    title: "EU AI Office - Energy consumption and emissions of AI models",
    subtitle:
      "Targeted consultation on measuring energy consumption and emissions of AI models and systems under the AI Act",
    href: null,
    jurisdiction: "European Union",
    committee: "European Commission / AI Office",
    committee_chair: null,
    inquiry_url:
      "https://digital-strategy.ec.europa.eu/en/consultations/targeted-consultation-measuring-energy-consumption-and-emissions-ai-models-and-systems",
    deadline: "15 May 2026",
    deadline_iso: "2026-05-15T23:59:00+02:00",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 80,
  },
  {
    slug: "uk-dsit-growing-up-online-2026",
    title: "UK DSIT - Growing up in the online world",
    subtitle:
      "National consultation on children, AI chatbots, generative AI, and age assurance",
    href: null,
    jurisdiction: "United Kingdom",
    committee: "Department for Science, Innovation and Technology (DSIT)",
    committee_chair: null,
    inquiry_url:
      "https://www.gov.uk/government/consultations/growing-up-in-the-online-world-a-national-consultation",
    deadline: "11:59pm, 26 May 2026",
    deadline_iso: "2026-05-26T22:59:00Z",
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 90,
  },
  {
    slug: "sg-imda-agentic-ai-mgf-2026",
    title: "Singapore IMDA - Model AI Governance Framework for Agentic AI",
    subtitle:
      "Rolling public feedback on agentic AI accountability, technical controls, and end-user responsibility",
    href: null,
    jurisdiction: "Singapore",
    committee: "Infocomm Media Development Authority (IMDA)",
    committee_chair: null,
    inquiry_url:
      "https://www.imda.gov.sg/resources/press-releases-factsheets-and-speeches/press-releases/2026/new-model-ai-governance-framework-for-agentic-ai",
    deadline: "Rolling (living document)",
    deadline_iso: null,
    submitted_at: null,
    submitted_via: null,
    status: "Draft" as const,
    source_file: null,
    pdf: null,
    docx: null,
    sort_order: 100,
  },
]

export const runSeed = mutation({
  args: {},
  handler: async (ctx) => {
    let inserted = 0
    let updated = 0
    for (const s of INITIAL_SUBMISSIONS) {
      const existing = await ctx.db
        .query("submissions")
        .withIndex("by_slug", (q) => q.eq("slug", s.slug))
        .unique()
      if (existing) {
        await ctx.db.patch(existing._id, s)
        updated++
      } else {
        await ctx.db.insert("submissions", s)
        inserted++
      }
    }
    return { inserted, updated, total: INITIAL_SUBMISSIONS.length }
  },
})
