# confusion-matrix

Confusion matrix calculator with precision, recall, F1, and accuracy for binary and multi-class.

## Requirements
- build(actuals[], predictions[]): returns ConfusionMatrix
- accuracy(cm): overall accuracy
- precision(cm, label?): precision per class or macro-averaged
- recall(cm, label?): recall per class or macro-averaged
- f1(cm, label?): F1 score
- renderMatrix(cm): ASCII confusion matrix

## Status

Quarantine - pending review.

## Location

`packages/tools/confusion-matrix.ts`
