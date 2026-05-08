/**
 * Adds an email to the sequence.
 * @param sequence - The email sequence array.
 * @param options - Email options including subject, body, delayDays, and goal.
 * @returns The ID of the added email.
 */
export function addEmail(sequence: { id: number; subject: string; body: string; delayDays: number; goal: string; variants: Array<{ type: 'subject' | 'body'; content: string }> }[], { subject, body, delayDays, goal }: { subject: string; body: string; delayDays: number; goal: string }): number {
  const id = sequence.length > 0 ? sequence[sequence.length - 1].id + 1 : 1;
  sequence.push({ id, subject, body, delayDays, goal, variants: [] });
  return id;
}

/**
 * Adds an A/B variant to an email.
 * @param email - The email object to add a variant to.
 * @param variant - The variant object with type and content.
 */
export function addVariant(email: { id: number; subject: string; body: string; delayDays: number; goal: string; variants: Array<{ type: 'subject' | 'body'; content: string }> }, variant: { type: 'subject' | 'body'; content: string }): void {
  email.variants.push(variant);
}

/**
 * Generates the email schedule from a sequence and start date.
 * @param sequence - The email sequence array.
 * @param startDate - The start date for the campaign.
 * @returns Array of scheduled emails with dates and IDs.
 */
export function generateSchedule(sequence: { id: number; subject: string; body: string; delayDays: number; goal: string; variants: Array<{ type: 'subject' | 'body'; content: string }> }[], startDate: Date): Array<{ date: Date; emailId: number }> {
  const schedule: Array<{ date: Date; emailId: number }> = [];
  let currentDate = new Date(startDate);
  for (const email of sequence) {
    currentDate = new Date(currentDate.getTime() + email.delayDays * 24 * 60 * 60 * 1000);
    schedule.push({ date: currentDate, emailId: email.id });
  }
  return schedule;
}

/**
 * Validates the email sequence for errors.
 * @param sequence - The email sequence array.
 * @returns Array of validation error messages.
 */
export function validateSequence(sequence: { id: number; subject: string; body: string; delayDays: number; goal: string; variants: Array<{ type: 'subject' | 'body'; content: string }> }[]): string[] {
  const errors: string[] = [];
  for (const email of sequence) {
    if (!email.goal) {
      errors.push(`Email ${email.id} is missing a goal`);
    }
    if (email.delayDays <= 0) {
      errors.push(`Email ${email.id} has invalid delayDays: ${email.delayDays}`);
    }
  }
  const subjects = new Set<string>();
  for (const email of sequence) {
    if (subjects.has(email.subject)) {
      errors.push(`Duplicate subject: "${email.subject}" in email ${email.id}`);
    } else {
      subjects.add(email.subject);
    }
  }
  return errors;
}

/**
 * Renders a plain text preview of an email with metadata.
 * @param email - The email object to preview.
 * @returns Plain text preview string.
 */
export function renderPreview(email: { id: number; subject: string; body: string; delayDays: number; goal: string; variants: Array<{ type: 'subject' | 'body'; content: string }> }): string {
  let preview = `Subject: ${email.subject}\n\n${email.body}\n\n`;
  if (email.variants.length > 0) {
    preview += 'Variants:\n';
    for (const variant of email.variants) {
      preview += `  ${variant.type}: ${variant.content}\n`;
    }
  }
  return preview;
}