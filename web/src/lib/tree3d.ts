export interface Tree3DColors {
  trunk: string;
  trunkDark: string;
  foliageBase: string;
  foliageHighlight: string;
  dew: string;
  pedestalGlow: string;
  goldenAura: string;
}

export type TreeSpeciesArchetype = 'oak' | 'banyan' | 'pine' | 'sakura';

export interface TreeSpeciesConfig {
  name: string;
  species: TreeSpeciesArchetype;
  description: string;
}

export const TREE_SPECIES: Record<number, TreeSpeciesConfig> = {
  1: {
    name: 'Cây Phong Tán Rộng',
    species: 'oak',
    description: 'Autumn Oak — Wide spreading boughs, asymmetrical canopy domes'
  },
  2: {
    name: 'Cổ Thụ Nghìn Năm',
    species: 'banyan',
    description: 'Ancient Banyan — Heavy twisting trunk, sprawling root buttresses'
  },
  3: {
    name: 'Tùng Bách Dáng Tháp',
    species: 'pine',
    description: 'Highland Pine — Tiered conical skirts stacking vertically in pagoda tiers'
  },
  4: {
    name: 'Anh Đào Dáng Liễu',
    species: 'sakura',
    description: 'Weeping Sakura — Graceful outward-arched branches, cascading blossom pads'
  }
};

export const TEAM_3D_PALETTES: Record<number, Tree3DColors> = {
  1: { // Đội 1: Phong Thu Hổ Phách (Autumn Amber Oak)
    trunk: '#5c3a21',
    trunkDark: '#382314',
    foliageBase: '#c84b31',
    foliageHighlight: '#e76f51',
    dew: '#ffe3a8',
    pedestalGlow: '#e76f51',
    goldenAura: '#ffd166'
  },
  2: { // Đội 2: Ngọc Lục Bảo (Emerald Banyan)
    trunk: '#4a3525',
    trunkDark: '#2b1e15',
    foliageBase: '#1b4332',
    foliageHighlight: '#40916c',
    dew: '#b7efc5',
    pedestalGlow: '#2a9d8f',
    goldenAura: '#ffe66d'
  },
  3: { // Đội 3: Bạch Quả Hoàng Kim (Golden Ginkgo Pine)
    trunk: '#543d2b',
    trunkDark: '#332419',
    foliageBase: '#b78028',
    foliageHighlight: '#e9c46a',
    dew: '#fff3b0',
    pedestalGlow: '#e9c46a',
    goldenAura: '#ffea00'
  },
  4: { // Đội 4: Sakura Anh Đào (Weeping Cherry Blossom)
    trunk: '#443126',
    trunkDark: '#281c15',
    foliageBase: '#b5179e',
    foliageHighlight: '#ff4d6d',
    dew: '#ffccd5',
    pedestalGlow: '#ff758f',
    goldenAura: '#ffd166'
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
