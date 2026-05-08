# Polymarket Signal Analysis - Top Trader Patterns

## Source

Trending post: "97 users on Polymarket with 80%+ hit rate and $100K+ in profit."

## What Top Polymarket Traders Actually Do

### Pattern 1: Resolution Timing Arbitrage

Top traders focus on markets approaching resolution where the outcome is nearly certain but the price hasn't fully converged to 0 or 100. A market at 92% with 48 hours to resolution and confirming news is nearly free money - the last 8% is pure profit from slow-moving capital.

**Signal:** Markets within 72 hours of resolution, price between 85-97% or 3-15%, with corroborating external data.

### Pattern 2: Information Edge via Primary Sources

The 80%+ hit rate traders don't use prediction markets as their signal - they use primary sources (government filings, court dockets, earnings calls, official statements) and trade when the market hasn't priced in publicly available but underreported information.

**Signal:** Divergence between primary source data and current market price.

### Pattern 3: Liquidity Provision in Stable Markets

Some top performers aren't directional traders at all. They provide liquidity by placing tight bids on both sides of stable markets, earning the spread. This looks like high hit rate because most positions resolve profitably by small amounts.

**Signal:** High-volume markets with tight spreads and low volatility.

### Pattern 4: Event Clustering

Markets for related events often misprice conditional probability. If Event A happens, Event B becomes 90% likely, but the market for B hasn't moved yet. Top traders monitor event clusters and trade the lag.

**Signal:** Correlated markets where one has moved but the other hasn't adjusted.

### Pattern 5: Contrarian Exits

Top traders take profit early. When they enter a position at 60% and it moves to 85%, they sell rather than wait for resolution. This locks in gains and frees capital for the next opportunity.

**Signal:** Portfolio management discipline, not market analysis per se.

## What We Can Build

A market scanner that:

1. Fetches active Polymarket markets via their public CLOB API
2. Identifies markets near resolution (by end date) with strong price signals
3. Cross-references with volume and liquidity data
4. Outputs a daily brief of top opportunities ranked by expected value

## API Details

- **Polymarket CLOB API:** `https://clob.polymarket.com`
- **Gamma API (market metadata):** `https://gamma-api.polymarket.com`
- Endpoints are public, no auth required for read-only market data
- Rate limits are generous for read operations

## Constraints

- Read-only analysis. No trading execution.
- No financial advice framing. This is data aggregation.
- No API keys needed for public market data.
- Fits within the proactive package's opportunity-scanning pattern.

## Applicability to 8gent

This fits the Entrepreneurship power (packages/proactive/) - the same pattern as GitHub bounty scanning but applied to prediction markets. The daemon can run it as a daily cron job and surface opportunities via Telegram or TUI.
