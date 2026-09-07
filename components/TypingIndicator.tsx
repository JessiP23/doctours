export function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div
        className="bubble-in flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-line bg-them px-4 py-3 shadow-sm"
        aria-label="Typing"
      >
        <span className="typing-dot inline-block h-2 w-2 rounded-full bg-muted" />
        <span className="typing-dot inline-block h-2 w-2 rounded-full bg-muted" />
        <span className="typing-dot inline-block h-2 w-2 rounded-full bg-muted" />
      </div>
    </div>
  );
}
