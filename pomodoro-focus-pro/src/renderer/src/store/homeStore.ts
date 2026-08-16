import { create } from 'zustand'
import type { HomeSummary } from '../../../shared/stats'

interface HomeStore {
  summary: HomeSummary | null
  loading: boolean
  load: () => Promise<void>
}

export const useHomeStore = create<HomeStore>((set) => ({
  summary: null,
  loading: false,
  load: async () => {
    set({ loading: true })
    try {
      const summary = await window.api.stats.homeSummary()
      set({ summary, loading: false })
    } catch {
      set({ loading: false })
    }
  }
}))