# rag-query-builder

RAG query builder that formulates retrieval queries, ranks chunks, and assembles context.

## Requirements
- buildQuery(userQuestion, conversationHistory): reformulates for retrieval
- rankChunks(chunks[], query, scoreFn): returns top-k chunks by relevance
- assembleContext(chunks[], tokenBudget): fits ranked chunks into budget
- buildPrompt(query, context, systemPrompt): returns final RAG prompt

## Status

Quarantine - pending review.

## Location

`packages/tools/rag-query-builder.ts`
