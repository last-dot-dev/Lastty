import { useState, type FormEvent } from "react";

export interface PendingApproval {
  id: string;
  message: string;
  options: string[];
}

export default function ReplyInput({
  approval,
  onSubmit,
}: {
  approval: PendingApproval;
  onSubmit: (choice: string) => void;
}) {
  const [value, setValue] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue("");
  }

  return (
    <form className="agent-reply-input" onSubmit={submit}>
      <span className="agent-reply-input__prompt" aria-hidden>
        ›
      </span>
      <div className="agent-reply-input__main">
        <div className="agent-reply-input__message">{approval.message}</div>
        <div className="agent-reply-input__row">
          {approval.options.length > 0 && (
            <div className="agent-reply-input__options">
              {approval.options.map((option) => (
                <button
                  type="button"
                  key={option}
                  className="agent-reply-input__option"
                  onClick={() => onSubmit(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <input
            className="agent-reply-input__field"
            autoFocus
            placeholder="reply to agent…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="submit"
            className="agent-reply-input__send"
            disabled={!value.trim()}
          >
            send
          </button>
        </div>
      </div>
    </form>
  );
}
