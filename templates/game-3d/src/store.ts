import { create } from 'zustand';

// Game state lives outside React's render tree so per-frame updates don't
// trigger re-renders. Read it inside useFrame via getState(); subscribe in
// HUD components that should re-render on change.
interface GameState {
  jumps: number;
  bump: () => void;
}

export const useGame = create<GameState>((set) => ({
  jumps: 0,
  bump: () => set((s) => ({ jumps: s.jumps + 1 })),
}));
