import { createRoot } from 'react-dom/client'
import '@xyflow/react/dist/style.css'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/mantine/style.css'
import 'streamdown/styles.css'

import '@/index.css'
import { initializeLocalTrialHandoff, isLocalTrial } from '@/lib/localTrialSession'

initializeLocalTrialHandoff(isLocalTrial)

// Third-party scripts must see only the sanitized URL.
const iconScript = document.createElement('script')
iconScript.src = 'https://kit.fontawesome.com/e33949a08a.js'
iconScript.crossOrigin = 'anonymous'
iconScript.async = true
document.head.appendChild(iconScript)

// App imports initialize analytics. Load them only after the local pass is removed from the URL.
void import('@/App.tsx').then(({ default: App }) => {
  createRoot(document.getElementById('root')!).render(<App />)
})
