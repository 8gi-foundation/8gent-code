/**
 * SpellChecker - basic spell checker using edit distance (Levenshtein)
 * Built-in ~500 common English words, suggests corrections, ignores code identifiers.
 */

const COMMON_WORDS = new Set([
  "a","able","about","above","accept","access","account","add","after","again","against",
  "age","agent","ago","all","allow","also","although","always","among","and","another",
  "any","appear","apply","are","around","as","ask","at","back","be","because","been",
  "before","behind","being","below","between","both","build","but","by","call","can",
  "case","change","check","child","clean","clear","close","code","come","common","complete",
  "config","connect","consider","contain","continue","control","copy","could","create",
  "current","data","day","default","define","delete","describe","design","detail","develop",
  "different","do","done","down","each","edit","else","end","enter","error","even","every",
  "example","export","extend","false","file","find","first","fix","follow","for","form",
  "format","from","full","function","get","give","global","go","good","great","group",
  "handle","has","have","help","here","how","if","implement","import","in","include",
  "index","info","input","install","into","is","it","its","just","keep","key","know",
  "last","later","let","like","list","load","local","log","long","look","make","many",
  "match","may","message","method","mode","module","more","move","must","name","need",
  "network","new","next","node","not","note","now","null","number","object","of","off",
  "on","only","open","option","or","other","out","output","over","own","package","parse",
  "pass","path","perform","place","plan","point","port","print","process","project",
  "provide","public","push","put","read","remove","render","replace","request","require",
  "reset","resolve","result","return","right","run","same","save","search","select","send",
  "server","set","show","size","some","source","start","state","static","status","step",
  "stop","string","support","system","table","task","test","than","that","the","their",
  "then","there","these","they","this","time","to","token","true","try","type","under",
  "update","use","user","value","view","wait","want","was","we","when","where","which",
  "while","will","with","work","would","write","yes","you","your",
  "array","async","await","boolean","break","catch","class","const","constructor",
  "debugger","declare","enum","extends","finally","implements","instanceof","interface",
  "null","private","protected","public","static","super","switch","throw","typeof",
  "undefined","var","void","yield",
  "active","address","admin","alert","allowed","api","app",
  "append","args","auth","auto","base","batch","block","body","branch","buffer","cache",
  "callback","calls","cast","channel","char","chunk","client","clone","cluster","column",
  "command","commit","component","consumer","container","content","context","controller",
  "convert","core","count","cursor","database","debug","delay","deploy","depth","device",
  "diff","directory","disable","dispatch","docs","driver","emit","empty","enable","engine",
  "entry","environment","event","execute","execution","exist","expect","expire","extension",
  "external","factory","fail","failure","field","fields","filter","flag","flush","folder",
  "force","header","hook","host","identity","image","inject","instance","integration",
  "internal","interval","invoke","item","items","job","json","kernel","label","layer",
  "layout","level","library","limit","link","lock","loop","map","memory","migration",
  "model","monitor","mount","mutation","namespace","offset","order","origin",
  "page","param","params","pattern","payload","plugin","pool","prefix","priority",
  "promise","property","protocol","provider","proxy","query","queue","record",
  "registry","reload","remote","retry","role","route","router","rule","schema","scope",
  "service","session","signal","socket","sort","split","stack","storage","store","strategy",
  "stream","sync","tag","target","template","timeout","topic","trace","transform",
  "trigger","url","version","watch","webhook","worker"
]);

/** Compute Levenshtein edit distance between two strings. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

/**
 * Returns true if word looks like a code identifier:
 * camelCase, PascalCase, snake_case, SCREAMING, or contains digits.
 */
function isCodeIdentifier(word: string): boolean {
  return /[A-Z]{2,}/.test(word) ||
    /[a-z][A-Z]/.test(word) ||
    /_/.test(word) ||
    /\d/.test(word) ||
    word.length <= 1;
}

export interface SpellCheckResult {
  word: string;
  correct: boolean;
  suggestions: string[];
}

export class SpellChecker {
  private dictionary: Set<string>;
  private maxSuggestions: number;
  private maxDistance: number;

  constructor(options: { maxSuggestions?: number; maxDistance?: number } = {}) {
    this.dictionary = new Set(COMMON_WORDS);
    this.maxSuggestions = options.maxSuggestions ?? 3;
    this.maxDistance = options.maxDistance ?? 2;
  }

  /** Add custom words to the dictionary. */
  addWords(words: string[]): void {
    for (const w of words) {
      this.dictionary.add(w.toLowerCase());
    }
  }

  /** Check a single word. Returns whether it is correct and up to N suggestions. */
  check(word: string): SpellCheckResult {
    const clean = word.replace(/[^a-zA-Z']/g, "");
    if (!clean || isCodeIdentifier(clean)) {
      return { word, correct: true, suggestions: [] };
    }
    const lower = clean.toLowerCase();
    if (this.dictionary.has(lower)) {
      return { word, correct: true, suggestions: [] };
    }
    const suggestions = this.suggest(lower);
    return { word, correct: false, suggestions };
  }

  /** Suggest corrections for a misspelled word. */
  suggest(word: string): string[] {
    const candidates: Array<{ word: string; dist: number }> = [];
    for (const dictWord of this.dictionary) {
      if (Math.abs(dictWord.length - word.length) > this.maxDistance) continue;
      const dist = editDistance(word, dictWord);
      if (dist <= this.maxDistance) {
        candidates.push({ word: dictWord, dist });
      }
    }
    return candidates
      .sort((a, b) => a.dist - b.dist)
      .slice(0, this.maxSuggestions)
      .map(c => c.word);
  }

  /**
   * Check all words in a text string.
   * Returns only misspelled words.
   */
  checkText(text: string): SpellCheckResult[] {
    const words = text.split(/\s+/);
    const results: SpellCheckResult[] = [];
    for (const word of words) {
      const result = this.check(word);
      if (!result.correct) results.push(result);
    }
    return results;
  }
}
