import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import TutorPage from './TutorPage'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TutorPage />
  </StrictMode>
)
