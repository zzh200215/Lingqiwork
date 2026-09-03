import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ReviewPage from './ReviewPage'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReviewPage />
  </StrictMode>
)
