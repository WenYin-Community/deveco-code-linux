/**
 * BM25 (Best Matching 25) ranking algorithm
 * Classic IR scoring function with term frequency saturation + document length normalization
 * Uses Intl.Segmenter for Chinese/English tokenization
 */

const K1 = 1.2
const B = 0.75

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })

function tokenize(text: string): string[] {
  const input = text.toLowerCase()
  const segments = [...segmenter.segment(input)]
  const tokens: string[] = []
  for (const seg of segments) {
    if (!seg.isWordLike) continue
    const word = seg.segment
    if (word.length >= 2) {
      tokens.push(word)
    } else if (word.length === 1 && !/[a-z0-9]/.test(word)) {
      tokens.push(word)
    }
  }
  return tokens
}

export class BM25 {
  private corpus: string[][] = []
  private docFreqs: Map<string, number> = new Map()
  private avgDocLen: number = 0
  private N: number = 0

  buildFromDocuments(documents: string[]): void {
    this.corpus = documents.map(d => tokenize(d))
    this.N = this.corpus.length
    this.docFreqs = new Map()

    let totalLen = 0
    for (const tokens of this.corpus) {
      totalLen += tokens.length
      const unique = new Set(tokens)
      for (const term of unique) {
        this.docFreqs.set(term, (this.docFreqs.get(term) || 0) + 1)
      }
    }
    this.avgDocLen = this.N > 0 ? totalLen / this.N : 0
  }

  score(query: string, documents: string[]): number[] {
    const queryTerms = tokenize(query)
    if (queryTerms.length === 0 || this.N === 0) return documents.map(() => 0)

    const results: number[] = []
    for (let i = 0; i < this.corpus.length; i++) {
      const docTokens = this.corpus[i]
      const docLen = docTokens.length

      const termFreqs = new Map<string, number>()
      for (const t of docTokens) {
        termFreqs.set(t, (termFreqs.get(t) || 0) + 1)
      }

      let docScore = 0
      for (const term of queryTerms) {
        const tf = termFreqs.get(term) || 0
        if (tf === 0) continue

        const df = this.docFreqs.get(term) || 0
        const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1)

        const tfNorm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (docLen / this.avgDocLen)))

        docScore += idf * tfNorm
      }

      results.push(docScore)
    }

    return results
  }
}