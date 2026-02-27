import './assets/main.css'
import './stores/quota-store'
import { createRoot } from 'react-dom/client'
import App from './App'
import { NotifyWindow } from './components/notify/NotifyWindow'

const isNotifyWindow = window.location.hash.startsWith('#notify')

createRoot(document.getElementById('root')!).render(
  isNotifyWindow ? <NotifyWindow /> : <App />
)
