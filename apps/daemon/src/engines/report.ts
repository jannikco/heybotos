// The report every worker must end with. Kept small so both engines can satisfy it reliably.
export const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'files_changed', 'verification', 'question', 'follow_ups', 'note_to_self'],
  properties: {
    status: {
      type: 'string',
      enum: ['done', 'needs_input', 'blocked', 'failed'],
      description: 'done = finished and checked. needs_input = a question only a person can answer. blocked = something outside your control stops you. failed = you tried and could not do it.',
    },
    summary: { type: 'string', description: 'What you did and what the result is, in plain sentences.' },
    files_changed: { type: 'array', items: { type: 'string' }, description: 'Paths you created, edited or deleted.' },
    verification: { type: 'string', description: 'What you ran or looked at to check the work, and what it showed. Empty if nothing was checked.' },
    question: { type: 'string', description: 'The one question you need answered, when status is needs_input. Otherwise empty.' },
    note_to_self: { type: 'string', description: 'One lasting thing you learned here that your future self should know when working in this project or for this owner again (a convention, a trap, a preference). Empty if there is nothing new. Not a summary of this task.' },
    follow_ups: { type: 'array', items: { type: 'string' }, description: 'Things you noticed that are worth doing next but were not part of this task.' },
  },
} as const
