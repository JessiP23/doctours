/**
 * The fixed opening the coordinator sends when a conversation starts.
 * Shown by the client immediately (no model call) and referenced in the system
 * prompt so the model knows the greeting already happened.
 */
export const OPENING_BUBBLES = [
  'Hi, I’m your Doctours travel coordinator.',
  'I’ll sort out your flights to Istanbul and your hotel around the procedure on the 13th.',
  'Whenever you’re ready, just tell me what you need.',
];
