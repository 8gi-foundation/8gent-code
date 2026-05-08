// ── Browser Research Benchmark ──────────────────────────────────────────────
// Tests: packages/tools/browser/
// Validates web fetch, DuckDuckGo search, link following, and HTML-to-text.

export const benchmark = {
  id: "AB006",
  name: "Browser: Web Research Pipeline",
  ability: "browser",
  difficulty: "hard" as const,

  prompt: `You have access to 8gent's browser tools (packages/tools/browser/).
Use them to complete a 4-step web research task. Show your work at each step.

Step 1 - Fetch and Extract:
  Use fetchPage to retrieve https://example.com.
  Report the page title, the first 100 characters of extracted text,
  and the total number of links found.
  Confirm the PageResult shape: { title, text, links, url, cached }.

Step 2 - Search and Parse:
  Use webSearch to search DuckDuckGo for "8gent autonomous coding agent".
  Report how many SearchResult objects were returned.
  Each result must have { title, url, snippet }.
  List the titles of the top 3 results.

Step 3 - Follow Links and Aggregate:
  Pick 2 URLs from the Step 2 search results.
  Use fetchPage on each URL.
  For each fetched page report: title, word count of extracted text,
  and count of outbound links.
  Summarize what the two pages have in common (topic, keywords).

Step 4 - HTML-to-Text Validation:
  Pass this raw HTML through htmlToText and verify the output:

  \`\`\`html
  <html>
  <head><title>Test Page</title></head>
  <body>
    <nav>Skip this nav</nav>
    <script>var x = "remove me";</script>
    <style>.hidden { display:none }</style>
    <main>
      <h1>Hello World</h1>
      <p>Paragraph with <a href="https://example.com">a link</a> and
         <a href="/relative">relative link</a>.</p>
      <p>Entity test: &amp; &lt; &gt; &quot; &#39;</p>
    </main>
    <footer>Skip footer</footer>
  </body>
  </html>
  \`\`\`

  Confirm:
  H1: title equals "Test Page"
  H2: nav, script, style, footer content is stripped
  H3: "Hello World" and "Paragraph with" appear in text
  H4: links array contains "https://example.com" and "/relative"
  H5: entities decoded correctly: & < > " '

Format answers as:
  Step 1: <findings>
  Step 2: <findings>
  Step 3: <findings>
  Step 4: H1=pass/fail, H2=pass/fail, H3=pass/fail, H4=pass/fail, H5=pass/fail`,

  successCriteria: [
    "Step 1 reports title, text excerpt, and link count from example.com",
    "Step 1 confirms PageResult has all 5 fields (title, text, links, url, cached)",
    "Step 2 returns SearchResult array with title, url, snippet per item",
    "Step 2 lists top 3 result titles from DuckDuckGo",
    "Step 3 fetches 2 pages from Step 2 URLs and reports title, word count, link count",
    "Step 3 includes a topical summary comparing the two pages",
    "Step 4 H1: title extracted as 'Test Page'",
    "Step 4 H2: nav, script, style, footer content absent from text output",
    "Step 4 H3: 'Hello World' and 'Paragraph with' present in text",
    "Step 4 H4: links array includes both https://example.com and /relative",
    "Step 4 H5: HTML entities decoded to literal characters",
  ],

  scoring: [
    { metric: "fetch_page_correct", weight: 0.20 },
    { metric: "web_search_parsed", weight: 0.20 },
    { metric: "multi_page_aggregation", weight: 0.30 },
    { metric: "html_to_text_validation", weight: 0.30 },
  ],

  timeLimit: 120,
};

export default benchmark;
