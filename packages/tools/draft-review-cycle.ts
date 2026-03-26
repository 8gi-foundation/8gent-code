/**
 * Represents a comment with author, timestamp, and text.
 */
interface Comment {
  author: string;
  timestamp: Date;
  text: string;
}

/**
 * Represents a timeline entry for state transitions or comments.
 */
interface TimelineEntry {
  type: 'transition' | 'comment';
  timestamp: Date;
  from?: string;
  to?: string;
  comment?: string;
  author?: string;
}

/**
 * Represents a revision summary with before and after content and timestamp.
 */
interface RevisionSummary {
  before: string;
  after: string;
  timestamp: Date;
}

/**
 * Represents a content draft with its lifecycle state and history.
 */
interface Draft {
  state: string;
  content: string;
  previousContent: string | null;
  comments: Comment[];
  timeline: TimelineEntry[];
  revisions: RevisionSummary[];
}

/**
 * Returns the next state based on current state and event.
 * @param state Current state.
 * @param event Transition event.
 * @returns Next state or throws error for invalid transitions.
 */
function transition(state: string, event: string): string {
  const transitions = {
    brief: { submit: 'draft' },
    draft: { submitForReview: 'review' },
    review: { requestRevision: 'revision' },
    revision: { submitForApproval: 'approved' },
    approved: { publish: 'published' },
  };

  if (!transitions[state] || !(event in transitions[state])) {
    throw new Error(`Invalid transition from ${state} with event ${event}`);
  }

  return transitions[state][event];
}

/**
 * Appends a reviewer comment to the draft with timestamp and author.
 * @param draft The draft to add the comment to.
 * @param comment The comment object with author and text.
 */
function addComment(draft: Draft, comment: { author: string; text: string }): void {
  const newComment: Comment = {
    author: comment.author,
    timestamp: new Date(),
    text: comment.text,
  };
  draft.comments.push(newComment);
  draft.timeline.push({
    type: 'comment',
    timestamp: newComment.timestamp,
    author: newComment.author,
    comment: newComment.text,
  });
}

/**
 * Returns a diff summary of each revision round.
 * @param draft The draft to summarize revisions for.
 * @returns Array of revision summaries with before/after content and timestamp.
 */
function summarizeRevisions(draft: Draft): RevisionSummary[] {
  return draft.revisions;
}

/**
 * Exports a chronological log of all state transitions and comments.
 * @param draft The draft to export the timeline for.
 * @returns Array of timeline entries.
 */
function exportTimeline(draft: Draft): TimelineEntry[] {
  return draft.timeline;
}

/**
 * Updates the draft's state and tracks content for revisions.
 * @param draft The draft to update.
 * @param event The transition event.
 * @param content The new content (if applicable).
 */
function updateDraftState(draft: Draft, event: string, content?: string): void {
  const nextState = transition(draft.state, event);
  draft.state = nextState;

  if (nextState === 'revision') {
    draft.previousContent = draft.content;
  } else if (nextState === 'approved') {
    if (draft.previousContent !== null) {
      draft.revisions.push({
        before: draft.previousContent,
        after: draft.content,
        timestamp: new Date(),
      });
      draft.previousContent = null;
    }
  } else if (content !== undefined) {
    draft.content = content;
  }

  draft.timeline.push({
    type: 'transition',
    timestamp: new Date(),
    from: draft.state,
    to: nextState,
  });
}