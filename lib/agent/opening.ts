/**
 * The fixed opening the coordinator sends when a conversation starts.
 * Shown by the client immediately (no model call) and referenced in the system
 * prompt so the model knows the greeting already happened.
 *
 * The last line asks how many people are travelling, and it is here rather than
 * left to the model on purpose. The prompt asked for it and the model skipped
 * straight to searching; a tool gate then stopped the search, and the model
 * satisfied the gate by asserting "one" instead of asking. A question the app
 * itself sends cannot be skipped or answered on the patient's behalf.
 */
export const OPENING_BUBBLES = [
  'Hi, I’m your Doctours travel coordinator.',
  'I’ll sort out your flights to Istanbul and your hotel around the procedure on the 13th.',
  'First thing I need to know: is it just you travelling, or is someone coming with you?',
];
