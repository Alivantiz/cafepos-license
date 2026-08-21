import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

document.documentElement.setAttribute('data-theme', localStorage.getItem('panel_theme') || 'dark')
createRoot(document.getElementById('root')).render(<App />)

// Без зарегистрированного service worker iOS не отдаёт push вообще, а при
// обрыве связи панель показывала бы белый экран. Регистрируем после загрузки,
// чтобы не отнимать сеть у первой отрисовки.
if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {})
  })
}
