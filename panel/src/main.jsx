import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

document.documentElement.setAttribute('data-theme', localStorage.getItem('panel_theme') || 'dark')
createRoot(document.getElementById('root')).render(<App />)
