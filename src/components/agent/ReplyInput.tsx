import { useState, type FormEvent } from "react";

export interface PromptInputModel {
  message: string;
  options?: string[];
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}

export default function ReplyInput({
  model,
  onSubmit,
}: {
  model: PromptInputModel;
  onSubmit: (choice: string) => void;
}) {
  const [value, setValue] = useState("");
  const options = model.options ?? [];

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
        <div className="agent-reply-input__message">{model.message}</div>
        <div className="agent-reply-input__row">
          {options.length > 0 && (
            <div className="agent-reply-input__options">
              {options.map((option) => (
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
            autoFocus={model.autoFocus}
            placeholder={model.placeholder ?? "reply to agent…"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            type="submit"
            className="agent-reply-input__send"
            disabled={!value.trim()}
          >
            {model.submitLabel ?? "send"}
          </button>
        </div>
      </div>
    </form>
  );
}
