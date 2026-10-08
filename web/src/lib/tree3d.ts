export interface Tree3DColors {
  trunk: string;
  trunkDark: string;
  foliageBase: string;
  foliageHighlight: string;
  dew: string;
  pedestalGlow: string;
  goldenAura: string;
}

export const TEAM_3D_PALETTES: Record<number, Tree3DColors> = {
  1: { // Đội 1: Phong Thu Đỏ (Autumn Maple)
    trunk: '#5c3a21',
    trunkDark: '#3d2413',
    foliageBase: '#c84b31',
    foliageHighlight: '#e76f51',
    dew: '#ffbe0b',
    pedestalGlow: '#e63946',
    goldenAura: '#ffd166'
  },
  2: { // Đội 2: Ngọc Lục Bảo (Emerald Grove)
    trunk: '#4a3525',
    trunkDark: '#2e1f14',
    foliageBase: '#1b4332',
    foliageHighlight: '#40916c',
    dew: '#70e000',
    pedestalGlow: '#2a9d8f',
    goldenAura: '#ffe66d'
  },
  3: { // Đội 3: Bạch Quả Hoàng Kim (Golden Ginkgo)
    trunk: '#543d2b',
    trunkDark: '#382619',
    foliageBase: '#d4a373',
    foliageHighlight: '#e9c46a',
    dew: '#f77f00',
    pedestalGlow: '#f4a261',
    goldenAura: '#ffea00'
  },
  4: { // Đội 4: Tử Đằng Huyền Ảo (Mystic Wisteria)
    trunk: '#443126',
    trunkDark: '#2a1b14',
    foliageBase: '#5a189a',
    foliageHighlight: '#9d4edd',
    dew: '#e0aaff',
    pedestalGlow: '#c77dff',
    goldenAura: '#f72585'
  }
};

/**
 * Capture high-res snapshot of a WebGL canvas and trigger download
 */
export function captureCanvasSnapshot(canvas: HTMLCanvasElement, filename = 'tree-3d-snapshot.png'): void {
  const dataUrl = canvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.download = filename;
  link.href = dataUrl;
  link.click();
}
