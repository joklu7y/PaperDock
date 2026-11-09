'use client';

import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { FileText, Upload, X, type LucideIcon } from 'lucide-react';
import { fileSize } from './api';
import { mobileWorkbench } from './platform';

// Material 3 building blocks styled after Google's own apps.

export function MaterialIcon({ name, className = '' }: { name: string; className?: string }) {
  return <span aria-hidden="true" className={`pd-symbol ${className}`}>{name}</span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'filled' | 'tonal' | 'outlined' | 'text' | 'danger';
  icon?: LucideIcon;
  symbol?: string;
  loading?: boolean;
};

const variants = {
  filled: 'md-filled bg-m-primary text-m-on-primary hover:shadow-md',
  tonal: 'bg-m-secondary-container text-m-on-secondary-container hover:shadow-sm',
  outlined: 'border border-m-outline text-m-primary hover:bg-m-primary/8',
  text: 'text-m-primary hover:bg-m-primary/8 px-3',
  danger: 'bg-m-error text-m-on-error hover:shadow-md',
};

export function Button({ variant = 'tonal', icon: Icon, symbol, loading, children, className = '', disabled, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      data-variant={variant}
      className={`md-button md-state-layer inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full px-6 text-sm font-medium tracking-[.01em] transition-all disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${variants[variant]} ${className}`}
      {...props}
    >
      {loading ? <span className="md-spinner" aria-hidden /> : mobileWorkbench && symbol ? <MaterialIcon name={symbol} /> : Icon && <Icon size={18} />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, symbol, label, className = '', active, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; symbol?: string; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`md-state-layer grid size-10 shrink-0 place-items-center rounded-full transition-colors disabled:opacity-40 ${active ? 'bg-m-secondary-container text-m-on-secondary-container' : 'text-m-on-surface-variant hover:bg-m-on-surface/8'} ${className}`}
      {...props}
    >
      {mobileWorkbench && symbol ? <MaterialIcon name={symbol} /> : <Icon size={20} />}
    </button>
  );
}

export function Card({ children, className = '', title, subtitle, actions }: { children?: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`md-card rounded-[24px] bg-m-surface-container-lowest p-6 ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            {title && <h3 className="text-base font-medium text-m-on-surface">{title}</h3>}
            {subtitle && <p className="mt-1 text-sm text-m-on-surface-variant">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, detail, actions }: { title: string; subtitle?: string; detail?: string; actions?: ReactNode }) {
  const supportingText = detail ?? (mobileWorkbench ? undefined : subtitle);
  return (
    <div className="md-header mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-[28px] font-normal leading-9 text-m-on-surface">{title}</h2>
        {supportingText && <p className="mt-1 break-words text-sm text-m-on-surface-variant">{supportingText}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, className = '', ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium text-m-on-surface-variant">{label}</span>
      <input className="md-input" {...props} />
      {hint && <span className="mt-1 block text-xs text-m-on-surface-variant">{hint}</span>}
    </label>
  );
}

export function Select({ label, children, className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium text-m-on-surface-variant">{label}</span>
      <select className="md-input" {...props}>{children}</select>
    </label>
  );
}

export function Chip({ selected, children, onClick, icon: Icon }: { selected?: boolean; children: ReactNode; onClick?: () => void; icon?: LucideIcon }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`md-chip md-state-layer inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm transition-colors ${selected ? 'border-transparent bg-m-secondary-container text-m-on-secondary-container' : 'border-m-outline-variant text-m-on-surface-variant hover:bg-m-on-surface/8'}`}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-3 text-sm text-m-on-surface">
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-8 w-[52px] rounded-full border-2 transition-colors ${checked ? 'border-m-primary bg-m-primary' : 'border-m-outline bg-m-surface-container-highest'}`}>
        <span className={`absolute top-1/2 -translate-y-1/2 rounded-full transition-all ${checked ? 'left-[22px] size-6 bg-m-on-primary' : 'left-1.5 size-4 bg-m-outline'}`} />
      </button>
      {label}
    </label>
  );
}

export function LinearProgress({ value }: { value?: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-m-secondary-container" role="progressbar" aria-valuenow={value}>
      {value === undefined ? <div className="md-indeterminate h-full bg-m-primary" /> : <div className="h-full rounded-full bg-m-primary transition-all" style={{ width: `${value}%` }} />}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center py-10 text-center text-m-on-surface-variant">
      <div className="mb-3 grid size-14 place-items-center rounded-full bg-m-surface-container-high"><Icon size={26} /></div>
      <p className="font-medium text-m-on-surface">{title}</p>
      {children && <p className="mt-1 max-w-md text-sm">{children}</p>}
    </div>
  );
}

/** Drag-and-drop file area with a removable file list. */
export function DropZone({ files, onFiles, accept, multiple = false, max = 10, label, hint, compact }: {
  files: File[]; onFiles: (files: File[]) => void; accept: string; multiple?: boolean; max?: number; label: string; hint?: string; compact?: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const allowed = accept.split(',').map((item) => item.trim().toLowerCase());
  const add = (list: FileList | File[] | null) => {
    const picked = Array.from(list || []).filter((file) => allowed.some((ext) => file.name.toLowerCase().endsWith(ext)));
    if (!picked.length) return;
    onFiles(multiple ? [...files, ...picked].slice(0, max) : picked.slice(0, 1));
  };
  return (
    <div>
      <button
        type="button"
        onClick={() => picker.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => { event.preventDefault(); setOver(false); add(event.dataTransfer.files); }}
        className={`md-drop-zone md-state-layer flex w-full flex-col items-center justify-center rounded-[20px] border-2 border-dashed text-center transition-colors ${compact ? 'gap-1 py-6' : 'gap-2 py-10'} ${over ? 'border-m-primary bg-m-primary-container/40' : 'border-m-outline-variant bg-m-surface-container-low hover:bg-m-surface-container'}`}
        data-drag-over={over}
      >
        <span className="md-drop-icon grid size-12 place-items-center rounded-full bg-m-primary-container text-m-on-primary-container">{mobileWorkbench ? <MaterialIcon name="upload_file" /> : <Upload size={22} aria-hidden="true" />}</span>
        <span className="md-drop-label mt-1 font-medium text-m-on-surface">{label}</span>
        {hint && !mobileWorkbench && <span className="px-4 text-xs text-m-on-surface-variant">{hint}</span>}
        <input ref={picker} type="file" hidden multiple={multiple} accept={accept} onChange={(event) => { add(event.target.files); event.target.value = ''; }} />
      </button>
      {files.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-m-outline-variant bg-m-surface-container-lowest py-1 pl-3 pr-1 text-sm">
              <FileText size={16} className="shrink-0 text-m-primary" />
              <span className="truncate">{multiple && `${index + 1}. `}{file.name}</span>
              <span className="shrink-0 text-xs text-m-on-surface-variant">{fileSize(file.size)}</span>
              <button type="button" aria-label={`移除 ${file.name}`} onClick={() => onFiles(files.filter((_, i) => i !== index))} className="grid size-7 place-items-center rounded-full hover:bg-m-on-surface/8"><X size={14} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ToolButton({ icon: Icon, title, description, onClick, disabled, loading }: { icon: LucideIcon; title: string; description?: string; onClick: () => void; disabled?: boolean; loading?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled || loading} className="md-tool-button md-state-layer group flex items-start gap-3 rounded-2xl border border-m-outline-variant bg-m-surface-container-lowest p-4 text-left transition-all hover:border-transparent hover:bg-m-surface-container-low hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50">
      <span className="md-tool-icon grid size-10 shrink-0 place-items-center rounded-xl bg-m-secondary-container text-m-on-secondary-container">{loading ? <span className="md-spinner" /> : <Icon size={20} />}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-m-on-surface">{title}</span>
        {description && !mobileWorkbench && <span className="mt-0.5 block text-xs leading-5 text-m-on-surface-variant">{description}</span>}
      </span>
    </button>
  );
}

export function Dialog({ open, title, children, actions, onClose }: { open: boolean; title: string; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={title} className="w-full max-w-xl rounded-[28px] bg-m-surface-container-high p-6 shadow-xl">
        <h3 className="mb-4 text-2xl text-m-on-surface">{title}</h3>
        {children}
        {actions && <div className="mt-6 flex justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function BottomSheet({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const sheet = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = sheet.current;
    if (open && element && !element.open) element.showModal();
    if (!open && element?.open) element.close();
  }, [open]);
  return (
    <dialog ref={sheet} aria-labelledby={titleId} className="pd-sheet" onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="pd-sheet-panel">
        <div className="pd-sheet-heading">
          <h3 id={titleId}>{title}</h3>
          <IconButton icon={X} symbol="close" label="关闭" onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
}
