import classics from "./config/classic-papers.v1.json" with { type: "json" }
import type { IndexedPaper } from "./local-index-builder"

export const CLASSIC_LIBRARY_VERSION = "classic_papers_v3"
export const CLASSIC_PAPERS = classics

function normalizedTitle(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
}

export function classicPaperName(paper: Pick<IndexedPaper, "title" | "arxivID">): string | undefined {
  const arxiv = paper.arxivID?.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, "").replace(/\.pdf$/i, "")
  return CLASSIC_PAPERS.find((entry) =>
    (arxiv && "arxivID" in entry && arxiv === entry.arxivID) || normalizedTitle(paper.title) === normalizedTitle(entry.title))?.name
}
