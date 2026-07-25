(() => {
  const storageKey = 'agent-wirelens-theme'
  const preferences = ['system', 'light', 'dark']
  const labels = {
    system: '系统',
    light: '亮色',
    dark: '深色',
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)')

  function readPreference() {
    try {
      const stored = window.localStorage.getItem(storageKey)
      return preferences.includes(stored) ? stored : 'system'
    } catch {
      return 'system'
    }
  }

  let preference = readPreference()

  function resolvedTheme() {
    if (preference === 'system') return media.matches ? 'dark' : 'light'
    return preference
  }

  function updateControl() {
    const button = document.getElementById('theme-toggle')
    const label = document.getElementById('theme-label')
    if (!button || !label) return
    const text = labels[preference]
    label.textContent = text
    button.title = `主题：${text}（点击切换）`
    button.dataset.preference = preference
  }

  function applyTheme() {
    const theme = resolvedTheme()
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.themePreference = preference
    document.documentElement.style.colorScheme = theme
    updateControl()
  }

  function setPreference(nextPreference) {
    preference = preferences.includes(nextPreference) ? nextPreference : 'system'
    try {
      window.localStorage.setItem(storageKey, preference)
    } catch {
      // Theme still works for the current page when storage is unavailable.
    }
    applyTheme()
  }

  function cyclePreference() {
    const currentIndex = preferences.indexOf(preference)
    setPreference(preferences[(currentIndex + 1) % preferences.length])
  }

  applyTheme()
  media.addEventListener('change', () => {
    if (preference === 'system') applyTheme()
  })

  window.addEventListener('DOMContentLoaded', () => {
    updateControl()
    document.getElementById('theme-toggle')?.addEventListener('click', cyclePreference)
  })
})()
