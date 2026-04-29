import { useState, useCallback, createContext, useContext } from 'react'

type ToastType = 'success' | 'error' | 'info'
interface ToastMsg { id: number; text: string; type: ToastType }
interface ToastCtx { toast: (text: string, type?: ToastType) => void }

const Ctx = createContext<ToastCtx>({ toast: () => {} })
export const useToast = () => useContext(Ctx)

let _id = 0
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const toast = useCallback((text: string, type: ToastType = 'info') => {
    const id = ++_id
    setToasts(p => [...p, { id, text, type }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 3500)
  }, [])
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.text}</div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
