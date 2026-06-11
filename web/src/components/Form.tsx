import { useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { passwordStrength, fmtBytes } from '@/lib/format';
import { LIMITS, ALLOWED_UPLOAD_MIME } from '@stn/shared';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (id: string, describedBy: string | undefined, invalid: boolean) => ReactNode;
}

export function Field({ label, error, hint, children }: FieldProps): JSX.Element {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, describedBy, !!error)}
      {error ? (
        <span className="field-error" id={`${id}-err`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

type TextInputProps = InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string };

export function TextInput({ label, error, hint, ...rest }: TextInputProps): JSX.Element {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, describedBy, invalid) => (
        <input id={id} className="input" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />
      )}
    </Field>
  );
}

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string };

export function TextArea({ label, error, hint, ...rest }: TextAreaProps): JSX.Element {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, describedBy, invalid) => (
        <textarea id={id} className="input" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />
      )}
    </Field>
  );
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string; children: ReactNode };

export function Select({ label, error, hint, children, ...rest }: SelectProps): JSX.Element {
  return (
    <Field label={label} error={error} hint={hint}>
      {(id, describedBy, invalid) => (
        <select id={id} className="input" aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function PasswordInput({
  label,
  error,
  value,
  onChange,
  autoComplete,
  withMeter,
}: {
  label: string;
  error?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  withMeter?: boolean;
}): JSX.Element {
  const [show, setShow] = useState(false);
  const level = passwordStrength(value);
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  return (
    <Field label={label} error={error} hint={withMeter && value ? `Strength: ${labels[level]}` : undefined}>
      {(id, describedBy, invalid) => (
        <>
          <div className="row" style={{ gap: 'var(--space-xxs)' }}>
            <input
              id={id}
              className="input"
              type={show ? 'text' : 'password'}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              autoComplete={autoComplete}
              minLength={LIMITS.passwordMinLength}
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
            >
              {show ? '🙈' : '👁'}
            </button>
          </div>
          {withMeter ? (
            <div className="strength" data-level={level} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </>
      )}
    </Field>
  );
}

/* ------------------------------ file drop ------------------------------ */

interface FileDropProps {
  onFile: (file: File) => void;
  busy?: boolean;
  accept?: string;
  label?: string;
}

export function FileDrop({ onFile, busy, accept, label }: FileDropProps): JSX.Element {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const validate = (file: File): string | null => {
    if (file.size > LIMITS.uploadMaxBytes) {
      return `File is ${fmtBytes(file.size)} — the limit is ${fmtBytes(LIMITS.uploadMaxBytes)}.`;
    }
    if (file.type && !(ALLOWED_UPLOAD_MIME as readonly string[]).includes(file.type)) {
      return `Unsupported type ${file.type}. Allowed: PDF, PNG, JPEG, WebP, AVIF, CSV, TXT.`;
    }
    return null;
  };

  const handle = (file: File | undefined) => {
    if (!file) return;
    const problem = validate(file);
    setError(problem);
    if (!problem) onFile(file);
  };

  return (
    <div className="col" style={{ gap: 'var(--space-xxs)' }}>
      <div
        className="dropzone"
        data-active={active}
        role="button"
        tabIndex={0}
        aria-label={label ?? 'Upload a file'}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setActive(true);
        }}
        onDragLeave={() => setActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setActive(false);
          handle(e.dataTransfer.files[0]);
        }}
      >
        {busy ? (
          <span>Scanning & uploading…</span>
        ) : (
          <>
            <strong>{label ?? 'Drop a file or tap to browse'}</strong>
            <span className="text-xs">PDF, images, CSV or TXT · up to {fmtBytes(LIMITS.uploadMaxBytes)} · scanned for malware & personal data</span>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          hidden
          accept={accept ?? '.pdf,.png,.jpg,.jpeg,.webp,.avif,.csv,.txt'}
          onChange={(e) => handle(e.target.files?.[0])}
        />
      </div>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
