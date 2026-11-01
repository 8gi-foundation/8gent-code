# observable

Observable values that notify subscribers on change.

## Requirements
- observable(initialValue) -> Observable<T>
- subscribe(observer) and unsubscribe
- computed(deps, fn) -> Observable derived value
- batch(fn) groups multiple mutations into single notification
- peek(obs) read without subscribing

## Status

Quarantine - pending review.

## Location

`packages/tools/observable.ts`
