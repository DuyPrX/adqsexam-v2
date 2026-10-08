export interface Tree3DColors {
  trunk: string;
  foliageBase: string;
  foliageHighlight: string;
  dew: string;
  goldenAura: string;
}

export const TEAM_3D_PALETTES: Record<number, Tree3DColors> = {
  1: { // Đội Đỏ / Cam Hồng
    trunk: '#4a2c11',
    foliageBase: '#2d6a4f',
    foliageHighlight: '#52b788',
    dew: '#ff4d6d',
    goldenAura: '#ffb703'
  },
  2: { // Đội Xanh Ngọc
    trunk: '#3d2612',
    foliageBase: '#1b4332',
    foliageHighlight: '#40916c',
    dew: '#00b4d8',
    goldenAura: '#ffd166'
  },
  3: { // Đội Vàng Nắng
    trunk: '#503215',
    foliageBase: '#386641',
    foliageHighlight: '#6a994e',
    dew: '#ffb703',
    goldenAura: '#ffea00'
  },
  4: { // Đội Tím Huyền Bí
    trunk: '#422818',
    foliageBase: '#2c514c',
    foliageHighlight: '#4d8b7a',
    dew: '#9d4edd',
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
