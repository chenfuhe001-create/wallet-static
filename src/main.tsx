import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SelfTest from './SelfTest'
import './styles.css'

const selfTest = new URLSearchParams(window.location.search).get('selftest') === '1'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{selfTest ? <SelfTest /> : <App />}</React.StrictMode>,
)
