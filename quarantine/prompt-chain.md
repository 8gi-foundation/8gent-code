# prompt-chain

Chain prompts sequentially, passing outputs as inputs.

## Requirements
- PromptChain with ordered steps
- each step: (input: string) => Promise<string>
- run(initialInput) executes chain and returns final output
- onStep callback for observability
- Abortable via AbortSignal

## Status

Quarantine - pending review.

## Location

`packages/tools/prompt-chain.ts`
