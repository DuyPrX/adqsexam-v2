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
  1: { // Đội 1: Phong Thu Hổ Phách (Autumn Amber)
    trunk: '#5c3a21',
    trunkDark: '#382314',
    foliageBase: '#e76f51',
    foliageHighlight: '#f4a261',
    dew: '#ffe3a8',
    pedestalGlow: '#e76f51',
    goldenAura: '#ffd166'
  },
  2: { // Đội 2: Ngọc Lục Bảo (Emerald Spring)
    trunk: '#4a3525',
    trunkDark: '#2b1e15',
    foliageBase: '#2a9d8f',
    foliageHighlight: '#52b788',
    dew: '#b7efc5',
    pedestalGlow: '#2a9d8f',
    goldenAura: '#ffe66d'
  },
  3: { // Đội 3: Bạch Quả Hoàng Kim (Golden Ginkgo)
    trunk: '#543d2b',
    trunkDark: '#332419',
    foliageBase: '#e9c46a',
    foliageHighlight: '#f3c053',
    dew: '#fff3b0',
    pedestalGlow: '#e9c46a',
    goldenAura: '#ffea00'
  },
  4: { // Đội 4: Sakura Anh Đào (Sakura Blossom)
    trunk: '#443126',
    trunkDark: '#281c15',
    foliageBase: '#d883b7',
    foliageHighlight: '#f3b0c3',
    dew: '#fde2e4',
    pedestalGlow: '#f7aef8',
    goldenAura: '#ffd6a5'
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
