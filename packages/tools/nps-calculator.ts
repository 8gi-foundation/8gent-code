/**
 * Calculates NPS from an array of scores.
 * @param scores Array of scores (0-10)
 * @returns NPS result with breakdown
 */
export function calculate(scores: number[]): { nps: number; promoters: number; passives: number; detractors: number; counts: { promoters: number; passives: number; detractors: number; total: number } } {
    let promoters = 0, passives = 0, detractors = 0;
    for (const score of scores) {
        if (score >= 9 && score <= 10) promoters++;
        else if (score >= 7 && score <= 8) passives++;
        else if (score >= 0 && score <= 6) detractors++;
    }
    const total = promoters + passives + detractors;
    const nps = (promoters - detractors) / total * 100;
    return { nps, promoters, passives, detractors, counts: { promoters, passives, detractors, total } };
}

/**
 * Analyzes NPS trends across periods.
 * @param scoresByPeriod Object mapping periods to score arrays
 * @returns Trend analysis with MoM deltas
 */
export function trend(scoresByPeriod: { [period: string]: number[] }): { [period: string]: { nps: number; delta: number | null } } {
    const periods = Object.keys(scoresByPeriod).sort();
    const result: { [period: string]: { nps: number; delta: number | null } } = {};
    for (let i = 0; i < periods.length; i++) {
        const period = periods[i];
        const scores = scoresByPeriod[period];
        const nps = calculate(scores).nps;
        result[period] = { nps, delta: i === 0 ? null : nps - calculate(scoresByPeriod[periods[i - 1]]).nps };
    }
    return result;
}

/**
 * Segments NPS by source.
 * @param responses Array of response objects
 * @param sourceKey Key to group by
 * @returns NPS breakdown by source
 */
export function segmentBySource(responses: { [key: string]: any }[], sourceKey: string): { [source: string]: { nps: number; promoters: number; passives: number; detractors: number; counts: { promoters: number; passives: number; detractors: number; total: number } } } {
    const grouped = responses.reduce((acc, response) => {
        const source = response[sourceKey];
        if (!acc[source]) acc[source] = { scores: [] };
        acc[source].scores.push(response.score);
        return acc;
    }, {} as { [source: string]: { scores: number[] } });
    const result: { [source: string]: { nps: number; promoters: number; passives: number; detractors: number; counts: { promoters: number; passives: number; detractors: number; total: number } } } = {};
    for (const source in grouped) {
        const { scores } = grouped[source];
        const { nps, promoters, passives, detractors, counts } = calculate(scores);
        result[source] = { nps, promoters, passives, detractors, counts };
    }
    return result;
}

/**
 * Renders formatted NPS summary.
 * @param result NPS result from calculate, trend, or segmentBySource
 * @returns Formatted report string
 */
export function renderSummary(result: any): string {
    if ('nps' in result) {
        const { nps, counts } = result;
        const benchmark = 30;
        return `NPS: ${nps.toFixed(1)} (${counts.promoters} promoters, ${counts.passives} passives, ${counts.detractors} detractors). ${nps > benchmark ? 'Above' : 'Below'} benchmark ${benchmark}.`;
    } else {
        const periods = Object.keys(result).sort();
        return periods.map(period => {
            const { nps, delta } = result[period];
            return `${period}: NPS ${nps.toFixed(1)}${delta !== null ? ` (Δ ${delta.toFixed(1)})` : ''}`;
        }).join('\n');
    }
}