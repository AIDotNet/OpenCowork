import './assets/main.css'
import './stores/quota-store'
import { createRoot } from 'react-dom/client'
import App from './App'
import { NotifyWindow } from './components/notify/NotifyWindow'
import { PetWindow } from './components/pet/PetWindow'
import { installStreamingPerfMonitor } from './lib/streaming-perf'

const isNotifyWindow = window.location.hash.startsWith('#notify')
const isPetWindow = new URLSearchParams(window.location.search).get('appView') === 'pet'

installStreamingPerfMonitor()

createRoot(document.getElementById('root')!).render(
  isNotifyWindow ? <NotifyWindow /> : isPetWindow ? <PetWindow /> : <App />
)
