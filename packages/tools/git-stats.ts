/**
 * Git Repository Statistics for 8gent
 *
 * Gathers commit frequency, lines added/removed, most active files,
 * and commit type breakdown from the local git history.
 * Zero external dependencies - uses git CLI via Bun.spawn.
 */

export interface CommitFrequency {
  daily: Record<string, number>;
  weekly: Record<string, number>;
  monthly: Record<string, number>;
  totalCommits: number;
  firstCommit: string | null;
  lastCommit: string | null;
}
export interface LineDelta { added: number; removed: number; net: number; }
export interface ActiveFile { path: string; commits: number; added: number; removed: number; }
export interface CommitTypeBreakdown { counts: Record<string, number>; total: number; topType: string | null; }
export interface GitStats { repoPath: string; timestamp: string; frequency: CommitFrequency; lines: LineDelta; activeFiles: ActiveFile[]; commitTypes: CommitTypeBreakdown; }

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return (await new Response(proc.stdout).text()).trim();
  } catch { return ''; }
}
function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}
function inc(map: Record<string,number>, key: string) { map[key] = (map[key] ?? 0) + 1; }
function addN(map: Record<string,number>, key: string, val: number) { map[key] = (map[key] ?? 0) + val; }
const KNOWN = ['feat','fix','docs','style','refactor','perf','test','chore','build','ci','revert','wip'];
function detectType(s: string): string {
  const l = s.toLowerCase().trim();
  for (const t of KNOWN) { if (l.startsWith(t+':') || l.startsWith(t+'(')) return t; }
  if (l.startsWith('add ') || l.startsWith('adds ')) return 'feat';
  if (l.startsWith('fix ') || l.startsWith('fixes ')) return 'fix';
  if (l.startsWith('update ') || l.startsWith('updates ')) return 'refactor';
  if (l.startsWith('remove ') || l.startsWith('removes ')) return 'chore';
  if (l.startsWith('merge ')) return 'merge';
  return 'other';
}
async function gatherFrequency(cwd: string): Promise<CommitFrequency> {
  const raw = await git(['log','--format=%H %aI'], cwd);
  if (!raw) return { daily:{}, weekly:{}, monthly:{}, totalCommits:0, firstCommit:null, lastCommit:null };
  const lines = raw.split('
').filter(Boolean);
  const daily: Record<string,number> = {}, weekly: Record<string,number> = {}, monthly: Record<string,number> = {};
  const dates: Date[] = [];
  for (const line of lines) {
    const parts = line.split(' ');
    if (parts.length < 2) continue;
    const d = new Date(parts[1]);
    if (isNaN(d.getTime())) continue;
    dates.push(d);
    inc(daily, d.toISOString().slice(0,10));
    inc(weekly, isoWeek(d));
    inc(monthly, d.toISOString().slice(0,7));
  }
  dates.sort((a,b) => a.getTime()-b.getTime());
  return { daily, weekly, monthly, totalCommits: lines.length,
    firstCommit: dates[0]?.toISOString()??null, lastCommit: dates.at(-1)?.toISOString()??null };
}
async function gatherLineDelta(cwd: string): Promise<LineDelta> {
  const raw = await git(['log','--numstat','--format='], cwd);
  let added=0, removed=0;
  for (const line of raw.split('
')) {
    const p = line.trim().split('	');
    if (p.length < 2) continue;
    const a=parseInt(p[0],10), r=parseInt(p[1],10);
    if (!isNaN(a)) added+=a; if (!isNaN(r)) removed+=r;
  }
  return { added, removed, net: added-removed };
}
async function gatherActiveFiles(cwd: string, topN=20): Promise<ActiveFile[]> {
  const cc: Record<string,number> = {};
  for (const l of (await git(['log','--name-only','--format='],cwd)).split('
')) {
    const f=l.trim(); if(f) inc(cc,f);
  }
  const fa: Record<string,number>={}, fr: Record<string,number>={};
  for (const l of (await git(['log','--numstat','--format='],cwd)).split('
')) {
    const p=l.trim().split('	'); if(p.length<3) continue;
    const a=parseInt(p[0],10),r=parseInt(p[1],10),path=p[2].trim();
    if(!path||isNaN(a)||isNaN(r)) continue;
    addN(fa,path,a); addN(fr,path,r);
  }
  return Object.keys(cc).map(path=>({path,commits:cc[path]??0,added:fa[path]??0,removed:fr[path]??0}))
    .sort((a,b)=>b.commits-a.commits).slice(0,topN);
}
async function gatherCommitTypes(cwd: string): Promise<CommitTypeBreakdown> {
  const counts: Record<string,number>={};
  for (const s of (await git(['log','--format=%s'],cwd)).split('
').filter(Boolean)) inc(counts,detectType(s));
  const total=Object.values(counts).reduce((s,v)=>s+v,0);
  const topType=Object.entries(counts).sort(([,a],[,b])=>b-a)[0]?.[0]??null;
  return {counts,total,topType};
}
export async function gatherStats(repoPath='.'): Promise<GitStats> {
  const [frequency,lines,activeFiles,commitTypes]=await Promise.all([
    gatherFrequency(repoPath),gatherLineDelta(repoPath),gatherActiveFiles(repoPath),gatherCommitTypes(repoPath)]);
  return {repoPath,timestamp:new Date().toISOString(),frequency,lines,activeFiles,commitTypes};
}
export function formatStats(stats: GitStats): string {
  const {frequency,lines,activeFiles,commitTypes}=stats;
  const sep='='.repeat(52);
  const months=Object.entries(frequency.monthly).sort(([a],[b])=>a.localeCompare(b))
    .map(([m,n])=>'  '+m+': '+n).join('
');
  const fileRows=activeFiles.slice(0,10)
    .map(f=>'  '+String(f.commits).padStart(4)+' commits  +'+String(f.added).padStart(6)+' -'+String(f.removed).padStart(6)+'  '+f.path)
    .join('
');
  const typeRows=Object.entries(commitTypes.counts).sort(([,a],[,b])=>b-a)
    .map(([t,n])=>{
      const pct=((n/(commitTypes.total||1))*100).toFixed(1);
      const bar='#'.repeat(Math.round(n/(commitTypes.total||1)*20));
      return '  '+t.padEnd(12)+' '+String(n).padStart(5)+'  '+pct.padStart(5)+'%  '+bar;
    }).join('
');
  return ['Git Stats - '+stats.repoPath,'Generated: '+stats.timestamp,sep,'',
    'COMMIT FREQUENCY',
    '  Total commits : '+frequency.totalCommits,
    '  First commit  : '+(frequency.firstCommit??'n/a'),
    '  Last commit   : '+(frequency.lastCommit??'n/a'),'',
    '  Monthly breakdown:',months||'  (no data)','',sep,'',
    'LINE DELTA (all time)',
    '  Added   : +'+lines.added.toLocaleString(),
    '  Removed : -'+lines.removed.toLocaleString(),
    '  Net     : '+(lines.net>=0?'+':'')+lines.net.toLocaleString(),'',sep,'',
    'MOST ACTIVE FILES (top 10 by commit count)',
    '  '+'commits'.padStart(4)+'          '+'added'.padStart(6)+' '+'removed'.padStart(6)+'  path',
    '  '+'-'.repeat(48),fileRows||'  (no data)','',sep,'',
    'COMMIT TYPE BREAKDOWN',
    '  '+'type'.padEnd(12)+' '+'count'.padStart(5)+'  '+'pct'.padStart(6)+'  distribution',
    '  '+'-'.repeat(48),typeRows||'  (no data)','',
    '  Top type: '+(commitTypes.topType??'n/a')].join('
');
}
if (import.meta.main) {
  const repoPath = process.argv[2] ?? '.';
  const stats = await gatherStats(repoPath);
  console.log(formatStats(stats));
}
