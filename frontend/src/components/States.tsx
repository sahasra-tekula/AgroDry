import { AlertCircle, LoaderCircle, RadioTower } from 'lucide-react'

export function LoadingState({ label = 'Loading data…' }: { label?: string }) {
  return (
    <div className="state-box" role="status">
      <LoaderCircle className="animate-spin text-leaf" size={22} />
      <span>{label}</span>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-box state-error" role="alert">
      <AlertCircle size={21} />
      <span>{message}</span>
      {onRetry && <button className="text-button" onClick={onRetry}>Try again</button>}
    </div>
  )
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><RadioTower size={21} /></span>
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  )
}

