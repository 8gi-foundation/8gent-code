/**
 * InvertedIndex class for building and querying an inverted index.
 */
export class InvertedIndex {
    private documents: Map<number, string> = new Map();
    private invertedIndex: Map<string, Map<number, number>> = new Map();

    /**
     * Adds a document with the given ID and text to the index.
     * @param id - The document ID.
     * @param text - The text content of the document.
     */
    add(id: number, text: string): void {
        const words = this.tokenize(text);
        const wordCounts = new Map<string, number>();
        for (const word of words) {
            wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }
        this.documents.set(id, text);
        for (const [word, count] of wordCounts) {
            let wordMap = this.invertedIndex.get(word);
            if (!wordMap) {
                wordMap = new Map();
                this.invertedIndex.set(word, wordMap);
            }
            wordMap.set(id, count);
        }
    }

    /**
     * Removes a document with the given ID from the index.
     * @param id - The document ID to remove.
     */
    remove(id: number): void {
        const text = this.documents.get(id);
        if (!text) return;
        const words = this.tokenize(text);
        for (const word of words) {
            const wordMap = this.invertedIndex.get(word);
            if (wordMap) {
                wordMap.delete(id);
                if (wordMap.size === 0) {
                    this.invertedIndex.delete(word);
                }
            }
        }
        this.documents.delete(id);
    }

    /**
     * Searches for documents containing all words in the query.
     * Returns an array of document IDs sorted by the sum of frequencies of query words in each document.
     * @param query - The search query string.
     * @returns Array of document IDs sorted by relevance.
     */
    search(query: string): number[] {
        const queryWords = this.tokenize(query);
        if (queryWords.length === 0) return [];
        let candidates = new Set<number>();
        for (const word of queryWords) {
            if (!this.invertedIndex.has(word)) {
                return [];
            }
            const wordDocs = this.invertedIndex.get(word);
            if (candidates.size === 0) {
                candidates = new Set(wordDocs.keys());
            } else {
                const temp = new Set<number>();
                for (const docId of candidates) {
                    if (wordDocs.has(docId)) {
                        temp.add(docId);
                    }
                }
                candidates = temp;
                if (candidates.size === 0) {
                    return [];
                }
            }
        }
        const result: { docId: number; score: number }[] = [];
        for (const docId of candidates) {
            let score = 0;
            for (const word of queryWords) {
                const wordDocs = this.invertedIndex.get(word);
                if (wordDocs) {
                    score += wordDocs.get(docId) || 0;
                }
            }
            result.push({ docId, score });
        }
        result.sort((a, b) => b.score - a.score);
        return result.map(item => item.docId);
    }

    private tokenize(text: string): string[] {
        return text.toLowerCase().match(/\b\w+\b/g) || [];
    }
}